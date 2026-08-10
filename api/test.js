// api/test.js
export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
        const envStatus = {
            SUPABASE_URL: process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing',
            SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? '✅ Set' : '❌ Missing',
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing',
            NODE_ENV: process.env.NODE_ENV || 'Not set',
            VERCEL_ENV: process.env.VERCEL_ENV || 'Not set'
        };
        
        return res.status(200).json({
            success: true,
            message: 'Test endpoint working',
            environment: envStatus,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
