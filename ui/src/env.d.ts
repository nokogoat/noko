// Types de l'environnement GJS (bibliothèques GObject accessibles par `gi://`).
/// <reference types="@girs/gjs" />
/// <reference types="@girs/gjs/dom" />
/// <reference types="@girs/gtk-4.0" />
/// <reference types="@girs/gtk4layershell-1.0" />

// Feuilles de style importées comme texte (esbuild, loader `text`).
declare module "*.css" {
  const css: string;
  export default css;
}

// gnim importe le type de libadwaita, que noko n'utilise pas.
declare module "gi://Adw" {
  const Adw: any;
  export default Adw;
}
