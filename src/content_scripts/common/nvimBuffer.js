// The neovim native host builds the scratch buffer name by string-concatenation
// into an `:exec` (`exec 'tabnew surfingkeys://' . a:fn` in server.lua), so any
// VimScript-significant character in the name would run as a command. The name is
// derived from `host/<tagName>` and the tag part is page-controlled (e.g. an
// element `<x"y>` yields the node name `x"y`), so it must be reduced to inert
// characters before it ever reaches nvim. Everything outside this whitelist —
// quotes, bars, backslashes, whitespace, newlines — becomes an underscore.
const SAFE_BUFFER_NAME = /[^A-Za-z0-9._:/-]/g;

export function sanitizeNvimBufferName(name) {
    if (typeof name !== 'string') {
        return '';
    }
    return name.replace(SAFE_BUFFER_NAME, '_');
}
