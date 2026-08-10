// api/admin.js - MINIMAL VERSION FOR DEBUGGING
import { createClient } from '@supabase/supabase-js';

// ============================================================
// CONFIG HANDLER - Minimal
// ============================================================
async function handleConfig(req, res) {
    try {
        console.log('[ADMIN] Config request received');
        
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

        console.log('[ADMIN] SUPABASE_URL exists:', !!supabaseUrl);
        console.log('[ADMIN] SUPABASE_ANON_KEY exists:', !!supabaseAnonKey);

        if (!supabaseUrl || !supabaseAnonKey) {
            return res.status(500).json({
                success: false,
                error: 'Supabase configuration missing'
            });
        }

        return res.status(200).json({
            success: true,
            supabaseUrl: supabaseUrl,
            supabaseAnonKey: supabaseAnonKey
        });
    } catch (error) {
        console.error('[ADMIN] Config error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        console.log(`📥 [ADMIN] ${req.method} ${pathname}`);

        // Only handle config for now
        if (pathname === '/api/admin/config') {
            return await handleConfig(req, res);
        }

        return res.status(404).json({ 
            success: false, 
            error: 'Not found' 
        });

    } catch (error) {
        console.error('❌ [ADMIN] Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
