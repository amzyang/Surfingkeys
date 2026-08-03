import { RUNTIME } from '../content_scripts/common/runtime.js';
import {
    setSanitizedContent,
} from '../content_scripts/common/utils.js';
document.addEventListener("surfingkeys:defaultSettingsLoaded", function(evt) {
    const { normal, api } = evt.detail;

    function disableNvim(reason) {
        setSanitizedContent(document.querySelector('#overlay'), reason);
        document.body.classList.add("neovim-disabled");
    }

    const np  = new Promise((resolve, reject) => {
        import(/* webpackIgnore: true */ './neovim_lib.js').then((nvimlib) => {
            nvimlib.default().then(({nvim, destroy}) => {
                function rpc(data) {
                    const [ event, args ] = data;
                    if (event === "Enter") {
                        if (args.length) {
                            normal.feedkeys(args[0]);
                        } else {
                            document.body.classList.add("neovim-disabled");
                            normal.enter();
                        }
                    }
                }
                nvim.on('nvim:open', () => {
                    nvim.input('<Esc>');
                    nvim.on('surfingkeys:rpc', rpc);
                });
                nvim.on('nvim:close', () => {
                    window.close();
                });
                nvim.on('nvim:connection_failed', () => {
                    disableNvim("Failed to connect to the neovim server.");
                    normal.enter();
                });
                nvim.on('nvim:decode_error', () => {
                    disableNvim("Lost sync with the neovim server.");
                    normal.enter();
                });
                resolve(nvim);
            });
        });
    });
    np.then((nvim) => {
        RUNTIME('connectNative', {mode: "standalone"}, (resp) => {
            if (resp.error) {
                disableNvim(resp.error);
            } else {
                normal.exit();
                api.mapkey('<Alt-i>', '', function() {
                    document.body.classList.remove("neovim-disabled");
                    normal.exit();
                });
                api.map('i', '<Alt-i>');
                nvim.connect(resp.url);
            }
        });
    });
});
