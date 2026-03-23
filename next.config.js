/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

module.exports = nextConfig;
