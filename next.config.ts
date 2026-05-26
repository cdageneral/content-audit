import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["playwright-core", "@sparticuz/chromium"],
  },
  // Increase serverless function body size limit for crawler payloads
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
    responseLimit: "8mb",
  },
};

export default nextConfig;
