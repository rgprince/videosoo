const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const ytdl = require('ytdl-core');

const app = express();
app.use(express.json());

// Configuration
const CONFIG = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_OWNER: process.env.GITHUB_OWNER,
    GITHUB_REPO: process.env.GITHUB_REPO,
    REFRESH_INTERVAL_HOURS: 3,
    BATCH_WINDOW_MINUTES: 5,
    API_PASSWORD: process.env.API_PASSWORD || 'your-secure-password'
};

// GitHub API setup
const octokit = new Octokit({
    auth: CONFIG.GITHUB_TOKEN
});

// Global variables
let refreshTimer = null;
let pendingUploads = [];
let linkDatabase = {};
let isRefreshing = false;

// Link ID encoder/decoder for obfuscation
class LinkEncoder {
    static encode(id) {
        // Simple base64 + random chars for obfuscation
        const encoded = Buffer.from(id).toString('base64');
        const random = Math.random().toString(36).substring(2, 5);
        return encoded.replace(/=/g, '') + random;
    }

    static decode(encodedId) {
        // Remove random chars and decode
        const base64 = encodedId.slice(0, -3) + '==';
        try {
            return Buffer.from(base64, 'base64').toString();
        } catch (e) {
            return null;
        }
    }
}

// YouTube to temporary link converter
class YouTubeConverter {
    static async getVideoInfo(url) {
        try {
            const info = await ytdl.getInfo(url);
            return {
                title: info.videoDetails.title,
                duration: info.videoDetails.lengthSeconds,
                isAvailable: true
            };
        } catch (error) {
            return {
                title: 'Unknown Video',
                duration: 0,
                isAvailable: false,
                error: error.message
            };
        }
    }

    static async convertToStreamLink(url) {
        try {
            // Get video info first
            const info = await ytdl.getInfo(url);
            
            // Get download formats - prefer high quality
            const formats = ytdl.filterFormats(info.formats, 'video');
            const bestFormat = formats.find(f => f.quality === 'highest') || formats[0];
            
            if (!bestFormat) {
                throw new Error('No video format available');
            }

            // Return temporary streaming URL (expires in 6+ hours)
            return {
                streamUrl: bestFormat.url,
                title: info.videoDetails.title,
                quality: bestFormat.qualityLabel || 'Unknown',
                expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6 hours
                isValid: true
            };
        } catch (error) {
            console.error('YouTube conversion error:', error.message);
            return {
                streamUrl: null,
                title: 'Conversion Failed',
                quality: 'N/A',
                expiresAt: null,
                isValid: false,
                error: error.message
            };
        }
    }
}

// Link health checker
class LinkHealthChecker {
    static async checkLink(streamUrl) {
        try {
            const response = await axios.head(streamUrl, { timeout: 10000 });
            return {
                isActive: response.status === 200,
                status: response.status,
                error: null
            };
        } catch (error) {
            return {
                isActive: false,
                status: error.response?.status || 0,
                error: error.message
            };
        }
    }

    static async checkAllLinks() {
        const brokenLinks = [];
        const results = {
            total: 0,
            active: 0,
            broken: 0,
            details: []
        };

        for (const [linkId, linkData] of Object.entries(linkDatabase)) {
            results.total++;
            
            if (!linkData.streamUrl) {
                brokenLinks.push({
                    id: linkId,
                    title: linkData.title,
                    reason: 'No stream URL',
                    originalUrl: linkData.originalUrl
                });
                results.broken++;
                continue;
            }

            const healthCheck = await this.checkLink(linkData.streamUrl);
            
            if (healthCheck.isActive) {
                results.active++;
            } else {
                brokenLinks.push({
                    id: linkId,
                    title: linkData.title,
                    reason: healthCheck.error || `HTTP ${healthCheck.status}`,
                    originalUrl: linkData.originalUrl
                });
                results.broken++;
            }

            results.details.push({
                id: linkId,
                title: linkData.title,
                status: healthCheck.isActive ? 'active' : 'broken',
                lastChecked: new Date()
            });
        }

        return { brokenLinks, results };
    }
}

// GitHub integration
class GitHubManager {
    static async updateLinksFile() {
        try {
            // Prepare data for GitHub (encoded links)
            const githubData = {};
            for (const [linkId, linkData] of Object.entries(linkDatabase)) {
                const encodedId = LinkEncoder.encode(linkId);
                githubData[encodedId] = {
                    url: linkData.streamUrl,
                    title: linkData.title,
                    updated: new Date().toISOString()
                };
            }

            // Get current file SHA
            let fileSha = null;
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner: CONFIG.GITHUB_OWNER,
                    repo: CONFIG.GITHUB_REPO,
                    path: 'links.json'
                });
                fileSha = data.sha;
            } catch (error) {
                // File doesn't exist, will create new
            }

            // Update/create file
            await octokit.rest.repos.createOrUpdateFileContents({
                owner: CONFIG.GITHUB_OWNER,
                repo: CONFIG.GITHUB_REPO,
                path: 'links.json',
                message: `Update links - ${new Date().toISOString()}`,
                content: Buffer.from(JSON.stringify(githubData, null, 2)).toString('base64'),
                sha: fileSha
            });

            console.log('✅ GitHub links.json updated successfully');
            return true;
        } catch (error) {
            console.error('❌ GitHub update failed:', error.message);
            return false;
        }
    }

    static async removeFromGitHub(encodedIds) {
        try {
            // Get current data
            const { data } = await octokit.rest.repos.getContent({
                owner: CONFIG.GITHUB_OWNER,
                repo: CONFIG.GITHUB_REPO,
                path: 'links.json'
            });

            const currentData = JSON.parse(Buffer.from(data.content, 'base64').toString());
            
            // Remove broken links
            encodedIds.forEach(id => {
                delete currentData[id];
            });

            // Update file
            await octokit.rest.repos.createOrUpdateFileContents({
                owner: CONFIG.GITHUB_OWNER,
                repo: CONFIG.GITHUB_REPO,
                path: 'links.json',
                message: `Remove broken links - ${new Date().toISOString()}`,
                content: Buffer.from(JSON.stringify(currentData, null, 2)).toString('base64'),
                sha: data.sha
            });

            return true;
        } catch (error) {
            console.error('Error removing from GitHub:', error.message);
            return false;
        }
    }
}

// Log collector and notifier
class LogCollector {
    static async sendBrokenLinksLog(brokenLinks) {
        if (brokenLinks.length === 0) return;

        const logData = {
            timestamp: new Date().toISOString(),
            brokenCount: brokenLinks.length,
            links: brokenLinks.map(link => ({
                id: link.id,
                title: link.title,
                reason: link.reason,
                originalUrl: link.originalUrl
            }))
        };

        // Log to console (you can extend this to send via email, webhook, etc.)
        console.log('\n🔴 BROKEN LINKS DETECTED:');
        console.log('================================');
        brokenLinks.forEach(link => {
            console.log(`❌ ${link.id} - "${link.title}" - ${link.reason}`);
        });
        console.log(`\nTotal broken: ${brokenLinks.length}`);
        console.log('================================\n');

        // You can add email/webhook notification here
        return logData;
    }

    static async generateRefreshLog(results) {
        const log = {
            timestamp: new Date().toISOString(),
            summary: {
                total: results.total,
                active: results.active,
                broken: results.broken
            },
            refreshDuration: results.duration || 0
        };

        console.log('\n📊 REFRESH COMPLETE:');
        console.log(`✅ Active: ${results.active}`);
        console.log(`❌ Broken: ${results.broken}`);
        console.log(`📦 Total: ${results.total}`);
        console.log(`⏱️ Duration: ${log.refreshDuration}ms\n`);

        return log;
    }
}

// Main refresh function
async function refreshAllLinks() {
    if (isRefreshing) {
        console.log('⏳ Refresh already in progress, skipping...');
        return;
    }

    isRefreshing = true;
    const startTime = Date.now();
    
    console.log('\n🔄 Starting links refresh...');

    try {
        // Check all existing links health
        const { brokenLinks, results } = await LinkHealthChecker.checkAllLinks();
        
        // Send broken links notification immediately
        if (brokenLinks.length > 0) {
            await LogCollector.sendBrokenLinksLog(brokenLinks);
            
            // Remove broken links from database
            brokenLinks.forEach(link => {
                delete linkDatabase[link.id];
            });
        }

        // Refresh all active links
        for (const [linkId, linkData] of Object.entries(linkDatabase)) {
            if (linkData.originalUrl) {
                const newStreamData = await YouTubeConverter.convertToStreamLink(linkData.originalUrl);
                if (newStreamData.isValid) {
                    linkDatabase[linkId].streamUrl = newStreamData.streamUrl;
                    linkDatabase[linkId].lastRefreshed = new Date();
                }
            }
        }

        // Update GitHub
        await GitHubManager.updateLinksFile();

        // Generate completion log
        const duration = Date.now() - startTime;
        results.duration = duration;
        await LogCollector.generateRefreshLog(results);

    } catch (error) {
        console.error('❌ Refresh error:', error.message);
    } finally {
        isRefreshing = false;
    }
}

// Batch upload handler
function scheduleBatchUpload() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(async () => {
        if (pendingUploads.length > 0) {
            console.log(`📦 Processing ${pendingUploads.length} pending uploads...`);
            
            // Process all pending uploads
            const uploads = [...pendingUploads];
            pendingUploads = [];

            // Add to database
            for (const upload of uploads) {
                linkDatabase[upload.id] = upload.data;
            }

            // Trigger refresh
            await refreshAllLinks();
        }
    }, CONFIG.BATCH_WINDOW_MINUTES * 60 * 1000);
}

// Generate next link ID
function generateLinkId(type = 'mov') {
    const existing = Object.keys(linkDatabase).filter(id => id.startsWith(type));
    const nextNum = existing.length + 1;
    return `${type}${String(nextNum).padStart(3, '0')}`;
}

// API Routes
app.post('/api/upload', async (req, res) => {
    try {
        const { links, password } = req.body;

        // Simple password protection
        if (password !== CONFIG.API_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        if (!links || !Array.isArray(links)) {
            return res.status(400).json({ error: 'Links array required' });
        }

        const results = [];
        
        for (const url of links) {
            // Get video info
            const videoInfo = await YouTubeConverter.getVideoInfo(url);
            const streamData = await YouTubeConverter.convertToStreamLink(url);
            
            // Generate link ID
            const linkId = generateLinkId('mov'); // You can make this dynamic based on content type
            const encodedId = LinkEncoder.encode(linkId);
            
            // Prepare data
            const linkData = {
                originalUrl: url,
                streamUrl: streamData.streamUrl,
                title: videoInfo.title,
                quality: streamData.quality,
                createdAt: new Date(),
                lastRefreshed: new Date(),
                isValid: streamData.isValid && videoInfo.isAvailable
            };

            // Add to pending uploads
            pendingUploads.push({
                id: linkId,
                data: linkData
            });

            results.push({
                originalUrl: url,
                masterLink: `https://${CONFIG.GITHUB_OWNER}.github.io/${CONFIG.GITHUB_REPO}/r/${encodedId}`,
                title: videoInfo.title,
                linkId: linkId,
                status: linkData.isValid ? 'success' : 'failed'
            });
        }

        // Schedule batch processing
        scheduleBatchUpload();

        res.json({
            success: true,
            results,
            message: `${results.length} links processed. Refresh will happen in ${CONFIG.BATCH_WINDOW_MINUTES} minutes.`
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

app.get('/api/status', (req, res) => {
    const oldLinksCount = LinkCleaner.getOldLinks().length;
    
    res.json({
        totalLinks: Object.keys(linkDatabase).length,
        totalViews: ViewTracker.getTotalViews(),
        pendingUploads: pendingUploads.length,
        oldLinksToClean: oldLinksCount,
        lastRefresh: new Date(), // You can store this properly
        isRefreshing,
        nextRefresh: refreshTimer ? 'Scheduled' : 'None',
        topLinks: ViewTracker.getTopLinks(5)
    });
});

// Scheduled refresh every 3 hours
cron.schedule(`0 */${CONFIG.REFRESH_INTERVAL_HOURS} * * *`, () => {
    console.log('⏰ Scheduled refresh triggered');
    refreshAllLinks();
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Render app running on port ${PORT}`);
    console.log(`🔄 Auto-refresh every ${CONFIG.REFRESH_INTERVAL_HOURS} hours`);
    console.log(`📦 Batch window: ${CONFIG.BATCH_WINDOW_MINUTES} minutes`);
});

// Initialize
console.log('🎬 Link Management System Started');
console.log('================================');
