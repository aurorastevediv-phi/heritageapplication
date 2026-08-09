// api/telegram.js
// Handles ALL Telegram notifications: page started, submissions

export default async function handler(req, res) {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { message, chat_id } = req.body;
        
        // Validate message
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        if (message.length > 4096) {
            return res.status(400).json({ error: 'Message too long' });
        }

        // Get client info
        const clientIp = req.headers['x-forwarded-for'] || 
                         req.headers['x-real-ip'] || 
                         req.connection?.remoteAddress ||
                         'unknown';

        // === RATE LIMITING ===
        const rateLimit = global.telegramRateLimit || new Map();
        global.telegramRateLimit = rateLimit;
        
        const now = Date.now();
        const windowMs = 60000;
        const maxRequests = 20;
        
        for (const [ip, data] of rateLimit.entries()) {
            if (now - data.timestamp > windowMs) {
                rateLimit.delete(ip);
            }
        }
        
        if (rateLimit.has(clientIp)) {
            const data = rateLimit.get(clientIp);
            if (now - data.timestamp < windowMs) {
                if (data.count >= maxRequests) {
                    const retryAfter = Math.ceil((windowMs - (now - data.timestamp)) / 1000);
                    res.setHeader('X-RateLimit-Limit', maxRequests);
                    res.setHeader('X-RateLimit-Remaining', 0);
                    res.setHeader('Retry-After', retryAfter);
                    return res.status(429).json({ 
                        error: 'Rate limit exceeded',
                        retryAfter: retryAfter
                    });
                }
                data.count++;
                res.setHeader('X-RateLimit-Remaining', maxRequests - data.count);
            } else {
                rateLimit.set(clientIp, { count: 1, timestamp: now });
                res.setHeader('X-RateLimit-Remaining', maxRequests - 1);
            }
        } else {
            rateLimit.set(clientIp, { count: 1, timestamp: now });
            res.setHeader('X-RateLimit-Remaining', maxRequests - 1);
        }
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

        // === ABUSE DETECTION ===
        const abuseDetection = global.abuseDetection || new Map();
        global.abuseDetection = abuseDetection;
        
        if (!abuseDetection.has(clientIp)) {
            abuseDetection.set(clientIp, {
                attempts: 1,
                firstSeen: now,
                lastSeen: now
            });
        } else {
            const data = abuseDetection.get(clientIp);
            data.attempts++;
            data.lastSeen = now;
            
            const timeWindow = (now - data.firstSeen) / 1000;
            const attemptRate = data.attempts / (timeWindow / 60);
            
            if (attemptRate > 50) {
                return res.status(429).json({ 
                    error: 'Access denied due to suspicious activity',
                    retryAfter: 3600
                });
            }
        }

        // Get environment variables
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const defaultChatId = process.env.TELEGRAM_CHAT_ID;

        if (!botToken) {
            console.error('Missing TELEGRAM_BOT_TOKEN');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // Determine which chat ID to send to
        let targetChatId = chat_id || defaultChatId;
        if (!targetChatId || targetChatId === 'your-chat-id') {
            console.error('No valid chat ID provided');
            return res.status(400).json({ error: 'No chat ID available' });
        }

        // Sanitize message
        const sanitize = (str) => {
            if (!str) return '';
            return String(str).replace(/[&<>"']/g, (m) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[m]);
        };

        const cleanMessage = sanitize(message);

        // Add minimal metadata
        const timestamp = new Date().toISOString();
        
        const formattedMessage = `
${cleanMessage}

📍 IP: ${sanitize(clientIp)}
🕐 ${timestamp}
        `;

        // === SEND TO TELEGRAM WITH RETRY ===
        let telegramResponse;
        let retryCount = 0;
        const maxRetries = 2;
        
        while (retryCount <= maxRetries) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                
                telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        chat_id: String(targetChatId).trim(),
                        text: formattedMessage,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (telegramResponse.ok) {
                    break;
                }
                
                retryCount++;
                if (retryCount <= maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                }
                
            } catch (fetchError) {
                retryCount++;
                if (retryCount <= maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                } else {
                    throw fetchError;
                }
            }
        }

        if (!telegramResponse || !telegramResponse.ok) {
            const errorData = telegramResponse ? await telegramResponse.json().catch(() => ({})) : {};
            console.error('Telegram API error:', errorData);
            return res.status(500).json({ error: 'Failed to send message after retries' });
        }

        const data = await telegramResponse.json();

        if (!data.ok) {
            console.error('Telegram API error:', data);
            return res.status(500).json({ error: 'Failed to send message' });
        }

        console.log(`✅ Message sent to Telegram: ${targetChatId}`);

        return res.status(200).json({ 
            success: true, 
            messageId: data.result?.message_id,
            timestamp: timestamp
        });

    } catch (error) {
        console.error('Server error:', error);
        
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Request timeout - Telegram API did not respond' });
        }
        
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            return res.status(503).json({ error: 'Network error - unable to reach Telegram API' });
        }
        
        return res.status(500).json({ error: 'Internal server error' });
    }
}
