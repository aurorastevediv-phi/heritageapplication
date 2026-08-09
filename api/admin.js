// api/admin.js
// Handles ALL admin functions: profile, applications, update-status

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Create Supabase client with service role (bypasses RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// ============================================================
// HANDLERS
// ============================================================

// ============================================================
// GET /config - Supabase config
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

// ============================================================
// GET /profile - Admin profile
// ============================================================
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

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - ' + (authError?.message || 'Invalid token')
            });
        }

        log('User verified:', user.email);

        // Query the admins table
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
            // Try to find by email as fallback
            const { data: adminByEmail, error: emailError } = await supabase
                .from('admins')
                .select('*')
                .eq('email', user.email)
                .maybeSingle();

            if (emailError) {
                logError('Admin by email query error:', emailError);
            }

            if (adminByEmail) {
                log('Found admin by email, updating auth_user_id...');
                
                const { error: updateError } = await supabase
                    .from('admins')
                    .update({ auth_user_id: user.id })
                    .eq('id', adminByEmail.id);

                if (updateError) {
                    logError('Failed to update auth_user_id:', updateError);
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to update admin record: ' + updateError.message
                    });
                }

                const { data: updatedAdmin, error: refetchError } = await supabase
                    .from('admins')
                    .select('*')
                    .eq('id', adminByEmail.id)
                    .single();

                if (refetchError) {
                    logError('Refetch error:', refetchError);
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to fetch updated admin record: ' + refetchError.message
                    });
                }

                delete updatedAdmin.auth_user_id;
                return res.status(200).json({
                    success: true,
                    data: updatedAdmin
                });
            }

            return res.status(404).json({ 
                success: false, 
                error: 'Admin account not found. Please contact support.'
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

// ============================================================
// GET /applications - Applications assigned to this admin
// ============================================================
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
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        log('User verified for applications:', user.email);

        // Get admin ID
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

        log('Fetching applications for admin:', admin.id);

        // Get all applications assigned to this admin
        const { data: applications, error: appsError } = await supabase
            .from('grants_applications')
            .select('*')
            .eq('assigned_admin_id', admin.id)
            .order('created_at', { ascending: false });

        if (appsError) {
            logError('Applications query error:', appsError);
            return res.status(500).json({ 
                success: false, 
                error: appsError.message 
            });
        }

        log('Applications found:', applications ? applications.length : 0);

        // Get referral links count for this admin
        const { count: referralCount, error: countError } = await supabase
            .from('referral_links')
            .select('*', { count: 'exact', head: true })
            .eq('admin_id', admin.id);

        if (countError) {
            logError('Referral count error:', countError);
        }

        return res.status(200).json({ 
            success: true, 
            data: {
                applications: applications || [],
                referral_count: referralCount || 0
            }
        });

    } catch (error) {
        logError('Applications handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// ============================================================
// GET /referral-links - Get all referral links for this admin
// ============================================================
async function handleReferralLinks(req, res) {
    try {
        log('Referral links request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        
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

        const { data: links, error: linksError } = await supabase
            .from('referral_links')
            .select('*')
            .eq('admin_id', admin.id)
            .order('created_at', { ascending: false });

        if (linksError) {
            logError('Referral links query error:', linksError);
            return res.status(500).json({ 
                success: false, 
                error: linksError.message 
            });
        }

        return res.status(200).json({
            success: true,
            data: links || []
        });

    } catch (error) {
        logError('Referral links handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// ============================================================
// POST /referral-links - Generate a new referral link
// ============================================================
async function handleCreateReferral(req, res) {
    try {
        log('Create referral link request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        
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
            .select('id, full_name')
            .eq('auth_user_id', user.id)
            .single();

        if (adminError || !admin) {
            logError('Admin not found:', adminError);
            return res.status(404).json({ 
                success: false, 
                error: 'Admin not found' 
            });
        }

        const { referral_name, referral_amount } = req.body || {};
        
        // Generate unique link identifier
        const linkId = 'REF-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const { data: newLink, error: linkError } = await supabase
            .from('referral_links')
            .insert([{
                admin_id: admin.id,
                link_identifier: linkId,
                referral_name: referral_name || null,
                referral_amount: referral_amount || null,
                is_used: false,
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (linkError) {
            logError('Referral link creation error:', linkError);
            return res.status(500).json({ 
                success: false, 
                error: linkError.message 
            });
        }

        const baseUrl = getBaseUrl();
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const linkUrl = `${protocol}://${baseUrl}/application.html?ref=${linkId}`;

        log('Generated referral link:', linkUrl);

        return res.status(200).json({
            success: true,
            data: {
                link: linkUrl,
                link_identifier: linkId,
                referral_name: referral_name || null,
                referral_amount: referral_amount || null,
                created_at: newLink.created_at
            }
        });

    } catch (error) {
        logError('Create referral handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}

// ============================================================
// POST /update-status - Update application status
// ============================================================
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
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        // Verify admin exists
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

        if (!applicationId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Application ID is required' 
            });
        }

        if (!status) {
            return res.status(400).json({ 
                success: false, 
                error: 'Status is required' 
            });
        }

        // Valid statuses
        const validStatuses = ['pending', 'approved', 'rejected', 'paid'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid status. Must be: pending, approved, rejected, or paid' 
            });
        }

        // Verify this application belongs to this admin
        const { data: appCheck, error: checkError } = await supabase
            .from('grants_applications')
            .select('id, assigned_admin_id')
            .eq('id', applicationId)
            .single();

        if (checkError || !appCheck) {
            logError('Application not found:', checkError);
            return res.status(404).json({ 
                success: false, 
                error: 'Application not found' 
            });
        }

        if (appCheck.assigned_admin_id !== admin.id) {
            logError('Admin not authorized to update this application');
            return res.status(403).json({ 
                success: false, 
                error: 'You are not authorized to update this application' 
            });
        }

        // Update the application
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

        log('Application status updated successfully');

        return res.status(200).json({ 
            success: true, 
            message: 'Status updated successfully',
            data: { applicationId, status }
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
// GET /referral-stats - Get referral statistics
// ============================================================
async function handleReferralStats(req, res) {
    try {
        log('Referral stats request received');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - No token provided' 
            });
        }

        const token = authHeader.split(' ')[1];
        
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

        // Get total applicants referred
        const { count: totalApplicants, error: countError } = await supabase
            .from('grants_applications')
            .select('*', { count: 'exact', head: true })
            .eq('assigned_admin_id', admin.id);

        if (countError) {
            logError('Count error:', countError);
        }

        // Get pending count
        const { count: pendingCount, error: pendingError } = await supabase
            .from('grants_applications')
            .select('*', { count: 'exact', head: true })
            .eq('assigned_admin_id', admin.id)
            .eq('status', 'pending');

        if (pendingError) {
            logError('Pending count error:', pendingError);
        }

        // Get approved count
        const { count: approvedCount, error: approvedError } = await supabase
            .from('grants_applications')
            .select('*', { count: 'exact', head: true })
            .eq('assigned_admin_id', admin.id)
            .in('status', ['approved', 'paid']);

        if (approvedError) {
            logError('Approved count error:', approvedError);
        }

        return res.status(200).json({
            success: true,
            data: {
                total_applicants: totalApplicants || 0,
                pending_count: pendingCount || 0,
                approved_count: approvedCount || 0
            }
        });

    } catch (error) {
        logError('Referral stats handler error:', error);
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
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        console.log(`📥 [ADMIN] ${req.method} ${pathname}`);

        let handlerFn = null;

        // Route based on exact path
        if (pathname === '/api/admin/config') {
            handlerFn = handleConfig;
        } else if (pathname === '/api/admin/profile') {
            handlerFn = handleProfile;
        } else if (pathname === '/api/admin/applications') {
            handlerFn = handleApplications;
        } else if (pathname === '/api/admin/referral-links') {
            if (req.method === 'GET') {
                handlerFn = handleReferralLinks;
            } else if (req.method === 'POST') {
                handlerFn = handleCreateReferral;
            }
        } else if (pathname === '/api/admin/update-status') {
            handlerFn = handleUpdateStatus;
        } else if (pathname === '/api/admin/referral-stats') {
            handlerFn = handleReferralStats;
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
