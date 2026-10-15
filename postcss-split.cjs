// PostCSS pipeline split by file (see docs/UI-REWORK.md §4, step (i)).
//
// app/globals.css (Tailwind theme + utilities + shadcn bridge) runs through @tailwindcss/postcss.
// Every other stylesheet (app/legacy.css) runs through Next's DEFAULT pipeline, exactly as before the
// bridge: a custom postcss.config replaces Next's defaults for every file, which silently dropped
// autoprefixer output from legacy.css (-webkit-backdrop-filter, position:-webkit-sticky, ...).
// Next's defaults are copied from next/dist/build/webpack/config/blocks/css/plugins.js
// (getDefaultPlugins) with Next's default browser targets (we have no browserslist config).
const path = require("node:path");

const TAILWIND_ENTRY = path.join(__dirname, "app", "globals.css");

let tailwindPlugins;
let nextDefaultPlugins;

function pluginsFor(file) {
  if (file && path.resolve(file) === TAILWIND_ENTRY) {
    tailwindPlugins ??= [require("@tailwindcss/postcss")()];
    return tailwindPlugins;
  }
  nextDefaultPlugins ??= [
    require("next/dist/compiled/postcss-flexbugs-fixes"),
    require("next/dist/compiled/postcss-preset-env")({
      browsers: require("next/dist/shared/lib/modern-browserslist-target"),
      autoprefixer: { flexbox: "no-2009" },
      stage: 3,
      features: { "custom-properties": false },
    }),
  ];
  return nextDefaultPlugins;
}

module.exports = () => ({
  postcssPlugin: "prospector-split",
  async Once(root, { result, postcss }) {
    const out = await postcss(pluginsFor(result.opts.from)).process(root, result.opts);
    if (out.root !== root) {
      root.removeAll();
      root.append(out.root.nodes);
    }
    result.messages.push(...out.messages);
  },
});
module.exports.postcss = true;
