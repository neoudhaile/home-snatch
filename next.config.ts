import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Craigslist
      { protocol: 'https', hostname: '**.craigslist.org' },
      // Reddit (post images, preview CDN, external preview proxy)
      { protocol: 'https', hostname: 'i.redd.it' },
      { protocol: 'https', hostname: 'preview.redd.it' },
      { protocol: 'https', hostname: 'external-preview.redd.it' },
      // Imgur (Reddit listings often link here)
      { protocol: 'https', hostname: 'i.imgur.com' },
      // Apify-hosted scraper output
      { protocol: 'https', hostname: 'images.apify.com' },
      { protocol: 'https', hostname: 'apify-image-resize.s3.eu-central-1.amazonaws.com' },
      // Zillow
      { protocol: 'https', hostname: 'photos.zillowstatic.com' },
      // StreetEasy
      { protocol: 'https', hostname: 'media.streeteasy.com' },
      // Unsplash (UI agent's mock placeholder photos)
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // Catch-all for various scraper-output CDNs on AWS
      { protocol: 'https', hostname: '**.amazonaws.com' },
    ],
  },
};

export default nextConfig;
