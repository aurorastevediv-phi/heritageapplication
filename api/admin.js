// api/admin.js - Using dynamic import to avoid startup crashes

let supabaseClient = null;
let createClientFn = null;

async function getSupabase() {
    if (supabaseClient) return supabaseClient;
    
    try {
        const module = await import('@supabase/supabase-js');
        createClientFn = module.createClient;
        supabaseClient = createClientFn(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
        console.log('[ADMIN] Supabase client initialized');
        return supabaseClient;
    } catch (error) {
        console.error('[ADMIN] Failed to initialize Supabase:', error);
        throw error;
    }
}

// ============================================================
// HELPERS
// ============================================================

function log(message, data) {
    console.log(`[ADMIN] ${message}`, data || '');
}

function logError(message, error) {
    console.error(`[ADMIN ERROR] ${message}`, error || '');
}

function getBaseUrl() {
    const customDomain = process.env.CUSTOM_DOMAIN;
    const projectUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const vercelUrl = process.env.VERCEL_URL;
    
    if (customDomain) return customDomain;
    if (projectUrl) return projectUrl;
    if (vercelUrl) return vercelUrl;
    return 'localhost:3000';
}

function generateLinkIdentifier() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return 'LK-' + timestamp + '-' + random;
}

// ============================================================
// HANDLERS
// ============================================================

async function handleConfig(req, res) {
    try {
        log('Config request received');
        
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseAnonKey) {
            logError('Missing Supabase configuration');
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
        logError('Config handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

async function handleProfile(req, res) {
    try {
        log('Profile request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        const supabase = await getSupabase();
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        log('User verified:', user.email);

        const { data: admin, error: adminError } = await supabase
            .from('admins')
            .select('*')
            .eq('auth_user_id', user.id)
            .maybeSingle();

        if (adminError) {
            logError('Admin query error:', adminError);
            return res.status(500).json({ 
                success: false, 
                error: 'Database error: ' + adminError.message 
            });
        }

        if (!admin) {
            const { data: adminByEmail, error: emailError } = await supabase
                .from('admins')
                .select('*')
                .eq('email', user.email)
                .maybeSingle();

            if (adminByEmail) {
                await supabase
                    .from('admins')
                    .update({ auth_user_id: user.id })
                    .eq('id', adminByEmail.id);

                const { data: updatedAdmin } = await supabase
                    .from('admins')
                    .select('*')
                    .eq('id', adminByEmail.id)
                    .single();

                delete updatedAdmin.auth_user_id;
                return res.status(200).json({
                    success: true,
                    data: updatedAdmin
                });
            }

            return res.status(404).json({ 
                success: false, 
                error: 'Admin account not found' 
            });
        }

        delete admin.auth_user_id;
        return res.status(200).json({
            success: true,
            data: admin
        });

    } catch (error) {
        logError('Profile handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

async function handleLinks(req, res) {
    try {
        log('Links request received:', req.method);
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        const supabase = await getSupabase();
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        const { data: admin, error: adminError } = await supabase
            .from('admins')
            .select('id')
            .eq('auth_user_id', user.id)
            .single();

        if (adminError || !admin) {
            logError('Admin not found:', adminError);
            return res.status(404).json({ 
                success: false, 
                error: 'Admin not found' 
            });
        }

        if (req.method === 'GET') {
            const { data: links, error: linksError } = await supabase
                .from('admin_links')
                .select('*')
                .eq('admin_id', admin.id)
                .order('created_at', { ascending: false });

            if (linksError) {
                logError('Links query error:', linksError);
                return res.status(500).json({ 
                    success: false, 
                    error: linksError.message 
                });
            }

            const activeLinks = links ? links.filter(link => link.is_active === true).length : 0;

            return res.status(200).json({
                success: true,
                data: {
                    links: links || [],
                    active_count: activeLinks,
                    max_links: 2
                }
            });
        }

        if (req.method === 'POST') {
            const { data: existingLinks, error: countError } = await supabase
                .from('admin_links')
                .select('id')
                .eq('admin_id', admin.id)
                .eq('is_active', true);

            if (countError) {
                logError('Count error:', countError);
                return res.status(500).json({ 
                    success: false, 
                    error: countError.message 
                });
            }

            const activeCount = existingLinks ? existingLinks.length : 0;

            if (activeCount >= 2) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Maximum 2 active links allowed',
                    active_count: activeCount,
                    max_links: 2
                });
            }

            const { referral_name, referral_amount } = req.body || {};
            const linkId = generateLinkIdentifier();

            const { data: newLink, error: linkError } = await supabase
                .from('admin_links')
                .insert([{
                    admin_id: admin.id,
                    link_identifier: linkId,
                    is_active: true,
                    referral_name: referral_name || null,
                    referral_amount: referral_amount || null
                }])
                .select()
                .single();

            if (linkError) {
                logError('Link creation error:', linkError);
                return res.status(500).json({ 
                    success: false, 
                    error: linkError.message 
                });
            }

            const baseUrl = getBaseUrl();
            const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
            const applicationLink = `${protocol}://${baseUrl}/application.html?token=${linkId}`;

            return res.status(200).json({
                success: true,
                data: {
                    link: applicationLink,
                    link_id: newLink.id,
                    link_identifier: linkId,
                    referral_name: newLink.referral_name,
                    referral_amount: newLink.referral_amount,
                    created_at: newLink.created_at,
                    active_count: activeCount + 1,
                    max_links: 2
                }
            });
        }

        if (req.method === 'DELETE') {
            const urlParts = req.url.split('/');
            const linkId = urlParts[urlParts.length - 1];

            if (!linkId || linkId === 'links') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Link ID is required' 
                });
            }

            const { data: link, error: linkCheckError } = await supabase
                .from('admin_links')
                .select('*')
                .eq('id', linkId)
                .eq('admin_id', admin.id)
                .single();

            if (linkCheckError || !link) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Link not found or unauthorized' 
                });
            }

            if (!link.is_active) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Link is already inactive' 
                });
            }

            const { error: updateError } = await supabase
                .from('admin_links')
                .update({ 
                    is_active: false,
                    updated_at: new Date().toISOString()
                })
                .eq('id', linkId)
                .eq('admin_id', admin.id);

            if (updateError) {
                logError('Deactivation error:', updateError);
                return res.status(500).json({ 
                    success: false, 
                    error: updateError.message 
                });
            }

            return res.status(200).json({
                success: true,
                message: 'Link deactivated successfully',
                data: { link_id: linkId }
            });
        }

        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed' 
        });

    } catch (error) {
        logError('Links handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

async function handleApplications(req, res) {
    try {
        log('Applications request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        const supabase = await getSupabase();
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        const { data: admin, error: adminError } = await supabase
            .from('admins')
            .select('id')
            .eq('auth_user_id', user.id)
            .single();

        if (adminError || !admin) {
            logError('Admin not found:', adminError);
            return res.status(404).json({ 
                success: false, 
                error: 'Admin not found' 
            });
        }

        const { data: applications, error: appsError } = await supabase
            .from('grants_applications')
            .select('*')
            .eq('admin_id', admin.id)
            .eq('is_link_application', true)
            .order('created_at', { ascending: false })
            .limit(20);

        if (appsError) {
            logError('Applications query error:', appsError);
            return res.status(500).json({ 
                success: false, 
                error: appsError.message 
            });
        }

        return res.status(200).json({ 
            success: true, 
            data: applications || [] 
        });

    } catch (error) {
        logError('Applications handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

async function handleUpdateStatus(req, res) {
    try {
        log('Update status request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        const supabase = await getSupabase();
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        const { data: admin, error: adminError } = await supabase
            .from('admins')
            .select('id')
            .eq('auth_user_id', user.id)
            .single();

        if (adminError || !admin) {
            logError('Admin not found:', adminError);
            return res.status(404).json({ 
                success: false, 
                error: 'Admin not found' 
            });
        }

        const { applicationId, status } = req.body;

        if (!applicationId || !status) {
            return res.status(400).json({ 
                success: false, 
                error: 'Application ID and status are required' 
            });
        }

        const validStatuses = ['pending', 'approved', 'rejected', 'paid'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid status' 
            });
        }

        const { error: updateError } = await supabase
            .from('grants_applications')
            .update({ 
                status: status,
                updated_at: new Date().toISOString()
            })
            .eq('id', applicationId);

        if (updateError) {
            logError('Update error:', updateError);
            return res.status(500).json({ 
                success: false, 
                error: updateError.message 
            });
        }

        return res.status(200).json({ 
            success: true, 
            message: 'Status updated successfully'
        });

    } catch (error) {
        logError('Update status handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
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

        let handlerFn = null;

        if (pathname === '/api/admin/config') {
            handlerFn = handleConfig;
        } else if (pathname === '/api/admin/profile') {
            handlerFn = handleProfile;
        } else if (pathname === '/api/admin/links') {
            handlerFn = handleLinks;
        } else if (pathname === '/api/admin/applications') {
            handlerFn = handleApplications;
        } else if (pathname === '/api/admin/update-status') {
            handlerFn = handleUpdateStatus;
        }

        if (!handlerFn) {
            console.log(`❌ [ADMIN] No handler for: ${req.method} ${pathname}`);
            return res.status(404).json({ 
                success: false, 
                error: 'Not found' 
            });
        }

        return await handlerFn(req, res);

    } catch (error) {
        console.error('❌ [ADMIN] Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
