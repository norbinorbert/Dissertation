const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = (_env, argv) => {
  const isProduction = argv.mode !== "development";

  return {
    mode: isProduction ? "production" : "development",
    // Extension pages disallow eval, so only inline source maps are usable in dev builds.
    devtool: isProduction ? false : "inline-source-map",
    entry: {
      content: "./src/content/index.ts",
      background: "./src/background.ts",
      engine: "./src/engine/engine.ts",
      popup: "./src/popup/popup.ts",
      options: "./src/options/options.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [{ from: "public", to: "." }],
      }),
    ],
    performance: {
      hints: false,
    },
    optimization: {
      // Each entry must stay self-contained: extension pages load a single script each.
      splitChunks: false,
      runtimeChunk: false,
    },
  };
};
