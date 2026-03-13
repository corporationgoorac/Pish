const express = require('express');
const ytSearch = require('yt-search');
const router = express.Router(); // Changed from 'app = express()' to 'router'

router.get('/', (req, res) => {
    res.send('🚀 Goorac Vision Direct Proxy is ONLINE!');
});

// Note: I removed '/api' from '/api/feed' here because we will add it in the master server.js
router.get('/feed', async (req, res) => {
    const rawTopic = req.query.topics || req.query.topic || "trending";
    const isVisionMode = req.query.mode === 'strict';
    
    let searchQuery = rawTopic.trim();
    if (!isVisionMode && !searchQuery.toLowerCase().includes('shorts')) {
        searchQuery += " shorts";
    }

    try {
        console.log(`Searching YouTube directly for: ${searchQuery}`);
        
        // Directly search YouTube (Bypasses all API blocks)
        const r = await ytSearch(searchQuery);
        const videos = r.videos;

        if (!videos || videos.length === 0) {
            return res.json({ success: true, bites: [] });
        }

        let filteredVideos = videos;
        if (!isVisionMode) {
            filteredVideos = videos.filter(v => v.seconds > 0 && v.seconds < 240);
            if (filteredVideos.length === 0) filteredVideos = videos.slice(0, 5);
        }

        const combinedFeed = filteredVideos.slice(0, 20).map(video => ({
            id: `yt_${video.videoId}_${Math.random().toString(36).substring(2, 7)}`,
            category: rawTopic,
            author: video.author ? video.author.name : "YouTube Creator",
            title: video.title,
            imgUrl: video.thumbnail || video.image,
            videoId: video.videoId, 
            likes: video.views || Math.floor(Math.random() * 5000), 
            link: video.url,
            type: 'video',
            lengthSeconds: video.seconds
        }));

        res.json({ success: true, bites: combinedFeed });
    } catch (error) {
        console.error("Direct Search Failed:", error);
        res.json({ success: false, bites: [] });
    }
});

// Export this router so the master server can use it
module.exports = router; 
