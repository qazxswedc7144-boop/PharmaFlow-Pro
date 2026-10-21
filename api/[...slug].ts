import { createRequire } from 'module';
import path from 'path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Application } from 'express';

const require = createRequire(import.meta.url);

let cachedApp: Application | null = null;

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
  memory: 1024,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1. Cold Start Optimization: Load app only once
    if (!cachedApp) {
      console.log('[Vercel] Loading application bundle...');
      
      // ✅ الإصلاح الأهم: استخدام المسار المطلق لتجنب مشاكل Vercel
      const bundlePath = path.join(process.cwd(), 'dist', 'server.cjs');
      const bundle = require(bundlePath);
      
      cachedApp = bundle.buildApp({ logHttp: false });
      console.log('[Vercel] Application loaded successfully');
    }

    // 2. Pass request to Express
    return cachedApp(req, res);
  } catch (err: any) {
    console.error('[Vercel Serverless Fatal Error]', err?.stack || err);
    
    // 3. Security: Hide sensitive error details in production
    if (!res.headersSent) {
      const isProduction = process.env.NODE_ENV === 'production';
      res.status(500).json({
        error: 'Serverless bootstrap failed',
        ...(isProduction ? {} : { details: err?.message || String(err) }),
      });
    }
  }
}
