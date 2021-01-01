import { ConfiguredPages, ConfiguredTabs, RGB } from '../common/types';
import type { Runtime, ContentScripts, Manifest, ExtensionTypes, Storage } from 'webextension-polyfill-ts';
declare var { browser }: typeof import('webextension-polyfill-ts');
import {
    get_prefs,
    set_pref,
    on_prefs_change,
    methods,
} from '../common/shared';
import { parseCSSColor } from 'csscolorparser';
import { relative_luminance } from '../common/color_utils';
import { get_merged_configured_common } from '../common/shared';

let platform_info: Promise<Runtime.PlatformInfo> = ('getPlatformInfo' in browser.runtime) ?
    browser.runtime.getPlatformInfo() :
    new Promise((_resolve, _reject) => {
        // TODO
    });

const configured_private: ConfiguredPages = {};
const configured_tabs: ConfiguredTabs = {};
function get_merged_configured(): Promise<ConfiguredPages> {
    return get_merged_configured_common(
        () => new Promise((resolve, _) => resolve(configured_private))
    );
}
browser.tabs.onRemoved.addListener(async (tabId) => {
    try {
        if (Object.keys(configured_private).length > 0) {
            for (let tab of await browser.tabs.query({})) {
                if (tab.incognito)
                    return;
            }
            for (let url of Object.keys(configured_private))
                delete configured_private[url];
            send_prefs({});
        }
        if (configured_tabs.hasOwnProperty(tabId))
            delete configured_tabs[tabId];
    } catch (e) {console.error(e);}
});

async function process_stylesheet(sheet: string, is_top_level_frame: boolean) {
    let options = await get_prefs();
    let is_dark_background = relative_luminance(parseCSSColor(options.default_background_color as string)!.slice(0, 3) as RGB) < relative_luminance(parseCSSColor(options.default_foreground_color as string)!.slice(0, 3) as RGB);
    let if_toplevel_start = is_top_level_frame ? '' : '/*';
    let if_toplevel_end = is_top_level_frame ? '' : '*/';
    let if_dark_background_start = is_dark_background ? '' : '/*';
    let if_dark_background_end = is_dark_background ? '' : '*/';
    let if_light_background_start = is_dark_background ? '/*' : '';
    let if_light_background_end = is_dark_background ? '*/' : '';

    let render_params = Object.assign(
        {},
        options,
        {
            if_dark_background_start,
            if_dark_background_end,
            if_light_background_start,
            if_light_background_end,
            if_toplevel_start,
            if_toplevel_end,
        }
    );
    let sheet_text = await (await fetch(browser.extension.getURL(sheet))).text();
    for (let key in render_params) {
        if (typeof render_params[key] === 'string')
            sheet_text = sheet_text.replace(
                new RegExp(`{${key}}`, 'g'),
                (render_params[key] as string).indexOf('#') === 0 ? (render_params[key] as string).slice(1) : render_params[key] as string
            );
    }
    return sheet_text;
}

browser.runtime.onMessage.addListener(async (message, sender) => {
    try {
        if (!message.action) {
            console.error('bad message!', message);
            return;
        }
        switch (message.action) {
            case 'query_tabId':
                return sender.tab?.id;
            case 'query_base_style':
                return await process_stylesheet('methods/base.css', true);
            case 'get_configured_private':
                return configured_private;
            case 'set_configured_private':
                if (message.value === null)
                    delete configured_private[message.key];
                else
                    configured_private[message.key] = message.value;
                send_prefs({});
                break;
            // @ts-ignore: 7029
            case 'get_my_tab_configuration':
                message.tab_id = sender.tab?.id;
                // falls through
            case 'get_tab_configuration':
                if (configured_tabs.hasOwnProperty(message.tab_id))
                    return configured_tabs[message.tab_id];
                else
                    return false;
            case 'set_configured_tab':
                if (message.value === null) {
                    if (configured_tabs.hasOwnProperty(message.key))
                        delete configured_tabs[message.key];
                } else
                    configured_tabs[message.key] = message.value;
                send_prefs({});
                break;
            case 'open_options_page':
                // while runtime.openOptionsPage() works from browserAction page script, due to bug 1414917 it behaves unintuitive on Fennec so here is a workaround
                if ((await platform_info).os === 'android')
                    setTimeout(() => browser.runtime.openOptionsPage(), 500);
                else
                    browser.runtime.openOptionsPage();
                break;
            case 'is_commands_update_available':
                return Object.prototype.hasOwnProperty.call(browser, 'commands') && Object.prototype.hasOwnProperty.call(browser.commands, 'update');
            case 'query_parent_method_number':
                if (sender.frameId === 0) {
                    console.error('Top-level frame requested some info about its parent. That should not happen. The sender is:', sender);
                    return await get_prefs('default_method');
                }
                return await browser.tabs.sendMessage(
                    sender.tab!.id!,
                    { action: 'get_method_number' },
                    { frameId: 0 },
                );
            default:
                console.error('bad message 2!', message);
                break;
        }
    } catch (e) { console.exception(e); }
});

const prev_scripts: ContentScripts.RegisteredContentScript[] = [];
async function send_prefs(changes: {[s: string]: Storage.StorageChange}) {
    prev_scripts.forEach(cs => cs.unregister());
    prev_scripts.length = 0;
    let from_manifest = (browser.runtime.getManifest() as Manifest.WebExtensionManifest).content_scripts![0];
    let new_data: ContentScripts.RegisteredContentScriptOptions = {matches: ["<all_urls>"]};
    let rendered_stylesheets: {[key: string]: string} = {};
    for (let css_path of Array.from(new Set(Object.values(methods).map(m => m.stylesheets).flat()))) {
        rendered_stylesheets[`${css_path}_iframe`] = await process_stylesheet(css_path, false);
        rendered_stylesheets[`${css_path}_toplevel`] = await process_stylesheet(css_path, true);
    }
    let code = `
        if (typeof content_script_state === 'undefined') { /* #226 part 1 workaround */
            window.content_script_state = 'registered_content_script_first';
        }

        window.prefs = ${ JSON.stringify(await get_prefs()) };
        window.merged_configured = ${ JSON.stringify(await get_merged_configured()) };
        window.configured_tabs = ${ JSON.stringify(configured_tabs) };
        window.rendered_stylesheets = ${ JSON.stringify(rendered_stylesheets) };
        if (window.content_script_state !== 'registered_content_script_first') { /* #226 part 1 workaround */
            window.do_it(${ JSON.stringify(changes) });
        }
    `;
    for (let key in from_manifest) {
        if (key === 'js') {
            new_data['js'] = [{ code }];
        } else {
            // convert to camelCase
            let new_key = key.split('_').map((el, index) => index === 0 ? el : el.charAt(0).toUpperCase() + el.slice(1)).join('');
            (new_data as any)[new_key] = (from_manifest as any)[key];
        }
    }
    prev_scripts.push(await browser.contentScripts.register(new_data));

    // same for already loaded pages
    let new_data_for_tabs: ExtensionTypes.InjectDetails = {code};
    for (let key in new_data) {
        if (['allFrames', 'matchAboutBlank', 'runAt'].indexOf(key) >= 0) {
            (new_data_for_tabs as any)[key] = (new_data as any)[key];
        }
    }
    for (let tab of await browser.tabs.query({})) {
        browser.tabs.executeScript(
            tab.id,
            new_data_for_tabs,
        );
    }
}
send_prefs({});
on_prefs_change(send_prefs);


if (browser.hasOwnProperty('commands')) {
    browser.commands.onCommand.addListener(async (name) => {
        try {
            let current_tab;
            switch (name) {
                case 'global_toggle_hotkey':
                    set_pref('enabled', !(await get_prefs('enabled')));
                    break;
                case 'tab_toggle_hotkey':
                    current_tab = (await browser.tabs.query({currentWindow: true, active: true}))[0];
                    if (configured_tabs.hasOwnProperty(current_tab.id!))
                        delete configured_tabs[current_tab.id!];
                    else
                        configured_tabs[current_tab.id!] = '0';
                    send_prefs({});
                    break;
                default:
                    console.error('bad command');
                    break;
            }
        } catch (e) { console.exception(e); }
    });
}

get_prefs('do_not_set_overrideDocumentColors_to_never').then(val => {
    if (!val) {
        // The extension can barely do anything when overrideDocumentColors == always
        // or overrideDocumentColors == high-contrast-only is set and high contrast mode is in use
        browser.browserSettings.overrideDocumentColors.set({value: 'never'}).catch(error => console.error(error));
    }
});

browser.webRequest.onHeadersReceived.addListener(
    details => {
        try {
            let headers = details.responseHeaders!.map(header => {
                if (header.name.toLowerCase() === 'content-security-policy') {
                    let new_values = header.value!.split(',').map(value => {
                        let directives: {[key: string]: string[]} = {};
                        for (let directive of value.split(';').map(d => d.trim()).filter(d => d.length > 0)) {
                            let parts = directive.split(' ').map(p => p.trim()).filter(p => p.length > 0);
                            let name = parts.shift()!;
                            directives[name] = parts;
                        }

                        if (directives.hasOwnProperty('style-src')) {
                            if (directives['style-src'].includes('data:'))
                                return value;
                            else
                                directives['style-src'].push('data:');
                        } else if (directives.hasOwnProperty('default-src')) {
                            if (directives['default-src'].includes('data:'))
                                return value;
                            else if (directives['default-src'].length === 1 && directives['default-src'][0] === "'none'")
                                directives['style-src'] = [ 'data:' ];
                            else {
                                directives['style-src'] = directives['default-src'].slice();
                                directives['style-src'].push('data:');
                            }
                        } else
                            return value;

                        return Object.keys(directives).map(k => `${k} ${directives[k].join(' ')}`).join('; ');
                    });
                    return {
                        name: header.name,
                        value: new_values.join(' , '),
                    };
                } else
                    return header;
            });

            return {
                responseHeaders: headers,
            };
        } catch (e) {
            console.error(e);
            return {};
        }
    },
    {
        urls: ['<all_urls>'],
        types: ['main_frame'],
    },
    [
        'blocking',
        'responseHeaders',
    ],
);
