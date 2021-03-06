/*
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd
Copyright 2017 Michael Telatynski <7t3chguy@gmail.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Squirrel on windows starts the app with various flags
// as hooks to tell us when we've been installed/uninstalled
// etc.
const checkSquirrelHooks = require('./squirrelhooks');
if (checkSquirrelHooks()) return;

const argv = require('minimist')(process.argv);
const {app, ipcMain, powerSaveBlocker, BrowserWindow, Menu} = require('electron');
const AutoLaunch = require('auto-launch');

const tray = require('./tray');
const vectorMenu = require('./vectormenu');
const webContentsHandler = require('./webcontents-handler');
const updater = require('./updater');

const windowStateKeeper = require('electron-window-state');

if (argv['profile']) {
    app.setPath('userData', `${app.getPath('userData')}-${argv['profile']}`);
}

let vectorConfig = {};
try {
    vectorConfig = require('../../webapp/config.json');
} catch (e) {
    // it would be nice to check the error code here and bail if the config
    // is unparseable, but we get MODULE_NOT_FOUND in the case of a missing
    // file or invalid json, so node is just very unhelpful.
    // Continue with the defaults (ie. an empty config)
}

let mainWindow = null;
global.appQuitting = false;


// handle uncaught errors otherwise it displays
// stack traces in popup dialogs, which is terrible (which
// it will do any time the auto update poke fails, and there's
// no other way to catch this error).
// Assuming we generally run from the console when developing,
// this is far preferable.
process.on('uncaughtException', function(error) {
    console.log('Unhandled exception', error);
});

let focusHandlerAttached = false;
ipcMain.on('setBadgeCount', function(ev, count) {
    app.setBadgeCount(count);
    if (count === 0 && mainWindow) {
        mainWindow.flashFrame(false);
    }
});

ipcMain.on('loudNotification', function() {
    if (process.platform === 'win32' && mainWindow && !mainWindow.isFocused() && !focusHandlerAttached) {
        mainWindow.flashFrame(true);
        mainWindow.once('focus', () => {
            mainWindow.flashFrame(false);
            focusHandlerAttached = false;
        });
        focusHandlerAttached = true;
    }
});

let powerSaveBlockerId;
ipcMain.on('app_onAction', function(ev, payload) {
    switch (payload.action) {
        case 'call_state':
            if (powerSaveBlockerId && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                if (payload.state === 'ended') {
                    powerSaveBlocker.stop(powerSaveBlockerId);
                }
            } else {
                if (payload.state === 'connected') {
                    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
                }
            }
            break;
    }
});


app.commandLine.appendSwitch('--enable-usermedia-screen-capturing');

const shouldQuit = app.makeSingleInstance((commandLine, workingDirectory) => {
    // If other instance launched with --hidden then skip showing window
    if (commandLine.includes('--hidden')) return;

    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

if (shouldQuit) {
    console.log('Other instance detected: exiting');
    app.exit();
}


const launcher = new AutoLaunch({
    name: vectorConfig.brand || 'RPG Chat',
    isHidden: true,
    mac: {
        useLaunchAgent: true,
    },
});

const settings = {
    'auto-launch': {
        get: launcher.isEnabled,
        set: function(bool) {
            if (bool) {
                return launcher.enable();
            } else {
                return launcher.disable();
            }
        },
    },
};

ipcMain.on('settings_get', async function(ev) {
    const data = {};

    try {
        await Promise.all(Object.keys(settings).map(async function (setting) {
            data[setting] = await settings[setting].get();
        }));

        ev.sender.send('settings', data);
    } catch (e) {
        console.error(e);
    }
});

ipcMain.on('settings_set', function(ev, key, value) {
    console.log(key, value);
    if (settings[key] && settings[key].set) {
        settings[key].set(value);
    }
});

app.on('ready', () => {
    if (argv['devtools']) {
        try {
            const { default: installExt, REACT_DEVELOPER_TOOLS, REACT_PERF } = require('electron-devtools-installer');
            installExt(REACT_DEVELOPER_TOOLS)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
            installExt(REACT_PERF)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
        } catch (e) {
            console.log(e);
        }
    }


    if (vectorConfig['update_base_url']) {
        console.log(`Starting auto update with base URL: ${vectorConfig['update_base_url']}`);
        updater.start(vectorConfig['update_base_url']);
    } else {
        console.log('No update_base_url is defined: auto update is disabled');
    }

    const iconPath = `${__dirname}/../img/rpg.${process.platform === 'win32' ? 'ico' : 'png'}`;

    // Load the previous window state with fallback to defaults
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1024,
        defaultHeight: 768,
    });

    mainWindow = global.mainWindow = new BrowserWindow({
        icon: iconPath,
        show: false,
        autoHideMenuBar: true,

        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,
    });
    mainWindow.loadURL(`file://${__dirname}/../../webapp/index.html`);
    Menu.setApplicationMenu(vectorMenu);

    // explicitly hide because setApplicationMenu on Linux otherwise shows...
    // https://github.com/electron/electron/issues/9621
    mainWindow.hide();

    // Create trayIcon icon
    tray.create({
        icon_path: iconPath,
        brand: vectorConfig.brand || 'RPG Chat',
    });

    mainWindow.once('ready-to-show', () => {
        mainWindowState.manage(mainWindow);

        if (!argv['hidden']) {
            mainWindow.show();
        } else {
            // hide here explicitly because window manage above sometimes shows it
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = global.mainWindow = null;
    });
    mainWindow.on('close', (e) => {
        if (!global.appQuitting && (tray.hasTray() || process.platform === 'darwin')) {
            // On Mac, closing the window just hides it
            // (this is generally how single-window Mac apps
            // behave, eg. Mail.app)
            e.preventDefault();
            mainWindow.hide();
            return false;
        }
    });

    if (process.platform === 'win32') {
        // Handle forward/backward mouse buttons in Windows
        mainWindow.on('app-command', (e, cmd) => {
            if (cmd === 'browser-backward' && mainWindow.webContents.canGoBack()) {
                mainWindow.webContents.goBack();
            } else if (cmd === 'browser-forward' && mainWindow.webContents.canGoForward()) {
                mainWindow.webContents.goForward();
            }
        });
    }

    webContentsHandler(mainWindow.webContents);
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    mainWindow.show();
});

app.on('before-quit', () => {
    global.appQuitting = true;
    if (mainWindow) {
        mainWindow.webContents.send('before-quit');
    }
});

// Set the App User Model ID to match what the squirrel
// installer uses for the shortcut icon.
// This makes notifications work on windows 8.1 (and is
// a noop on other platforms).
app.setAppUserModelId('com.squirrel.fabric.RPG');
