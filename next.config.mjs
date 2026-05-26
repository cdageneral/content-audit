/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "playwright-core",
      "@sparticuz/chromium",
      "cheerio",
      "undici",
      "xml2js",
      "@neondatabase/serverless",
      "@anthropic-ai/sdk",
      "@upstash/qstash",
    ],
  },
};

export default nextConfig;
