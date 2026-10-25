// Which shell this build runs in. The same source ships twice: as the web
// app (vite.config.ts → dist/) and as a store-signed Manifest V3 browser
// extension (vite.extension.config.ts → dist-extension/). The handful of
// places that differ ask here instead of sniffing the URL.
//
// It is a build-time constant: the extension config defines it as true, the
// web config as false, so each bundle carries only its own branch. Under
// Node (the check scripts) nothing defines it and it reads as false.

declare const __KAILAH_EXTENSION__: boolean | undefined

export const IS_EXTENSION: boolean =
  typeof __KAILAH_EXTENSION__ === 'boolean' && __KAILAH_EXTENSION__
