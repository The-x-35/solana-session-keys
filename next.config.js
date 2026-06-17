/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Solana / Anchor libs reference node core modules that don't exist in the
    // browser. Stub them so the client bundle builds.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      os: false,
      crypto: false,
      // optional pretty-logger pulled transitively by walletconnect; not needed
      "pino-pretty": false,
    };
    config.externals = config.externals || [];
    return config;
  },
};

module.exports = nextConfig;
