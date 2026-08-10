// api/admin.js
// Handles ALL admin functions: profile, links, applications, config, update-status

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
    // Priority: CUSTOM_DOMAIN > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_URL > fallback
    const customDomain = process.env.CUSTOM_DOMAIN;
    const projectUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const vercelUrl = process.env.VERCEL_URL;
    
    if (customDomain) {
        return customDomain;
    }
    if (projectUrl) {
        return projectUrl;
    }
    if (vercelUrl) {
        return vercelUrl;
    }
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

// ============================================================
// GET /config - Supabase config (CRITICAL for admin login)
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

        log('Config returned successfully');

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
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - Invalid token' 
            });
        }

        log('Verifying user with token...');
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - ' + authError.message 
            });
        }

        if (!user) {
            log('No user found from token');
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized - User not found' 
            });
        }

        log('User verified:', user.email);
        log('User ID:', user.id);

        // Query the admins table using service role (bypasses RLS)
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
            log('Admin not found for user ID:', user.id);
            
            // Try to find by email as fallback
            log('Trying to find admin by email:', user.email);
            const { data: adminByEmail, error: emailError } = await supabase
                .from('admins')
                .select('*')
                .eq('email', user.email)
                .maybeSingle();

            if (emailError) {
                logError('Admin by email query error:', emailError);
            }

            if (adminByEmail) {
                log('Found admin by email:', adminByEmail.email);
                log('Updating auth_user_id to match...');
                
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

                log('Admin record updated successfully');
                delete updatedAdmin.auth_user_id;

                return res.status(200).json({
                    success: true,
                    data: updatedAdmin
                });
            }

            return res.status(404).json({ 
                success: false, 
                error: 'Admin account not found. Please contact support.',
                debug: {
                    user_id: user.id,
                    user_email: user.email
                }
            });
        }

        log('Admin found:', admin.email);

        // Remove sensitive data before sending
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
// GET /links - List admin links
// POST /links - Generate new link
// DELETE /links/:id - Deactivate link
// ============================================================
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
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            logError('Auth error:', authError);
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        log('User verified for links:', user.email);

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

        // GET - List links
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

            // Count active links
            const activeLinks = links ? links.filter(link => link.is_active === true).length : 0;

            log('Links fetched:', links ? links.length : 0, 'Active:', activeLinks);

            return res.status(200).json({
                success: true,
                data: {
                    links: links || [],
                    active_count: activeLinks,
                    max_links: 2
                }
            });
        }

        // POST - Generate new link
        if (req.method === 'POST') {
            // Check current active links count
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
                log('Max links reached. Active:', activeCount);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Maximum 2 active links allowed. Please deactivate a link first.',
                    active_count: activeCount,
                    max_links: 2
                });
            }

            const { referral_name, referral_amount } = req.body || {};
            const linkId = generateLinkIdentifier();

            log('Generating link with ID:', linkId);

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

            log('Generated link:', applicationLink);

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

        // DELETE - Deactivate link
        if (req.method === 'DELETE') {
            // Extract link ID from URL path
            const urlParts = req.url.split('/');
            const linkId = urlParts[urlParts.length - 1];

            if (!linkId || linkId === 'links') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Link ID is required' 
                });
            }

            log('Deactivating link:', linkId);

            // Verify link belongs to this admin
            const { data: link, error: linkCheckError } = await supabase
                .from('admin_links')
                .select('*')
                .eq('id', linkId)
                .eq('admin_id', admin.id)
                .single();

            if (linkCheckError || !link) {
                logError('Link not found or unauthorized:', linkCheckError);
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

            // Get updated active count
            const { data: remainingLinks, error: countError } = await supabase
                .from('admin_links')
                .select('id')
                .eq('admin_id', admin.id)
                .eq('is_active', true);

            const activeCount = remainingLinks ? remainingLinks.length : 0;

            log('Link deactivated successfully. Active links remaining:', activeCount);

            return res.status(200).json({
                success: true,
                message: 'Link deactivated successfully',
                data: {
                    link_id: linkId,
                    active_count: activeCount,
                    max_links: 2
                }
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

// ============================================================
// GET /applications - Recent applicants
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

        log('Applications fetched:', applications ? applications.length : 0);

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

        log('User verified for status update:', user.email);

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

        log('Updating application:', applicationId, 'to status:', status);

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

        let handlerFn = null;

        // Route based on exact path
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
        } else if (pathname.startsWith('/api/admin/links/') && req.method === 'DELETE') {
            // Handle DELETE /api/admin/links/:id
            handlerFn = handleLinks;
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
