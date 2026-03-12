const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const PushNotifications = require('@pusher/push-notifications-server');

const app = express();

// --- STRICT CACHES to prevent duplicate sends and reaction spam ---
const processedMessages = new Set();
const processedNotifs = new Set();
const reactionThrottle = new Set(); 

// Allows your monitors to ping this server without CORS errors
app.use(cors()); 
app.use(express.json());

// --- HEALTH CHECK ROUTES FOR UPTIME MONITORS ---
app.get('/', (req, res) => {
  res.send('Goorac Push Server is Online and Permanent!');
});

app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// 1. Initialize Firebase Admin SDK
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin initialized successfully");
    } catch (error) {
        console.error("❌ Failed to initialize Firebase Admin.", error);
    }
}

const db = admin.firestore();

// 2. Initialize Pusher Beams
const beamsClient = new PushNotifications({
  instanceId: '66574b98-4518-443c-9245-7a3bd9ac0ab7',
  secretKey: '99DC07D1A9F9B584F776F46A3353B3C3FC28CB53EFE8B162D57EBAEB37669A6A' 
});

// ============================================================================
// LISTENER 1: CHATS, GROUP CHATS, DIRECT REPLIES, AND REACTIONS
// ============================================================================
function startMessageListener() {
    console.log("🎧 Listening for Chat Messages, Group Chats & Reactions...");

    db.collectionGroup('messages').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            
            if (change.type === 'added' || change.type === 'modified') {
                const messageData = change.doc.data();
                const docId = change.doc.id;
                
                // RELIABLE TIMESTAMP: Uses Firestore's un-hackable server-side times
                let msgTime = 0;
                if (change.doc.createTime) msgTime = change.doc.createTime.toMillis();
                if (change.doc.updateTime && change.type === 'modified') msgTime = change.doc.updateTime.toMillis();

                // CRITICAL FIX: Only process events that occurred in the last 2 minutes (120000ms).
                // This completely prevents historical notification spam on server restart, 
                // while ensuring that the action that woke the server up STILL gets processed properly!
                if (!msgTime || Date.now() - msgTime > 120000) return;

                // -----------------------------------------------------------------
                // A. HANDLE BRAND NEW MESSAGES & REPLIES
                // -----------------------------------------------------------------
                if (change.type === 'added') {
                    if (processedMessages.has(docId)) return;
                    processedMessages.add(docId);
                    setTimeout(() => processedMessages.delete(docId), 180000); 

                    try {
                        const senderUid = messageData.sender;
                        if (!senderUid) return; 

                        const chatRef = change.doc.ref.parent.parent;
                        const chatDocId = chatRef.id;
                        const chatDoc = await chatRef.get();
                        
                        const chatData = chatDoc.exists ? chatDoc.data() : {};
                        const isGroup = chatData.isGroup === true;
                        
                        let targetUids = [];
                        
                        if (isGroup) {
                            targetUids = (chatData.participants || []).filter(uid => uid !== senderUid);
                        } else {
                            const extractedUids = chatDocId.split('_');
                            if (extractedUids.length === 2) {
                                targetUids = [extractedUids[0] === senderUid ? extractedUids[1] : extractedUids[0]];
                            } else {
                                targetUids = (chatData.participants || []).filter(uid => uid !== senderUid);
                            }
                        }

                        if (targetUids.length === 0) return; 
                        
                        const senderDoc = await db.collection('users').doc(senderUid).get();
                        const senderData = senderDoc.data() || {};
                        let senderName = senderData.name || senderData.username || "Someone";
                        const senderPhoto = senderData.photoURL || "https://www.goorac.biz/icon.png";
                        const senderUsername = senderData.username || senderUid;

                        if (isGroup) senderName = `${senderName} in ${chatData.groupName || 'Group'}`;

                        // SMART HTML/REPLY FILTERING: Extracts rawText to prevent HTML div tags showing in notifications
                        let bodyText = "New message";
                        if (messageData.rawText) {
                            bodyText = messageData.rawText;
                        } else if (messageData.text && !messageData.isHtml && !messageData.text.includes('<div')) {
                            bodyText = messageData.text;
                        } else {
                            if (messageData.isDropReply || messageData.replyToNote || messageData.isHtml) bodyText = "💬 Replied to your post";
                            else if (messageData.isBite) bodyText = "🎬 Sent a Bite video";
                            else if (messageData.isGif) bodyText = "🎞️ Sent a GIF";
                            else if (messageData.imageUrl) bodyText = "📷 Sent an image";
                            else if (messageData.fileMeta?.type?.includes('audio')) bodyText = "🎵 Sent a voice message";
                            else if (messageData.fileUrl) bodyText = "📎 Sent an attachment";
                        }

                        const deepLink = isGroup 
                            ? `https://www.goorac.biz/groupChat.html?id=${chatDocId}` 
                            : `https://www.goorac.biz/chat.html?user=${senderUsername}`;

                        targetUids.forEach(async (targetUid) => {
                            await beamsClient.publishToInterests([targetUid], {
                                web: { notification: { title: senderName, body: bodyText, icon: senderPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: true }, time_to_live: 3600 },
                                fcm: { notification: { title: senderName, body: bodyText, icon: senderPhoto }, data: { click_action: deepLink }, priority: "high" },
                                apns: { aps: { alert: { title: senderName, body: bodyText }, "thread-id": chatDocId }, headers: { "apns-priority": "10", "apns-push-type": "alert" } }
                            });
                        });
                    } catch (error) { console.error("❌ Message Push Error:", error); }
                }

                // -----------------------------------------------------------------
                // B. HANDLE MESSAGE REACTIONS (THROTTLED TO PREVENT SPAM)
                // -----------------------------------------------------------------
                if (change.type === 'modified' && messageData.reactions) {
                    try {
                        const messageOwner = messageData.sender; 
                        if (!messageOwner) return;

                        for (const [reactorUid, reactionData] of Object.entries(messageData.reactions)) {
                            
                            if (reactorUid === messageOwner) continue; 
                            if (!reactorUid) continue;

                            const throttleKey = `throttle_${docId}_${reactorUid}`;
                            if (reactionThrottle.has(throttleKey)) continue;
                            
                            reactionThrottle.add(throttleKey);
                            setTimeout(() => reactionThrottle.delete(throttleKey), 10000); 

                            // Timestamp boundary to prevent reaction spam from older cached DB updates
                            if (Date.now() - reactionData.timestamp > 120000) continue;

                            const reactionCacheKey = `reaction_${docId}_${reactorUid}_${reactionData.emoji}`;
                            if (processedMessages.has(reactionCacheKey)) continue;
                            processedMessages.add(reactionCacheKey);
                            setTimeout(() => processedMessages.delete(reactionCacheKey), 180000);

                            const chatRef = change.doc.ref.parent.parent;
                            const chatDocId = chatRef.id;
                            const chatDoc = await chatRef.get();
                            
                            const chatData = chatDoc.exists ? chatDoc.data() : {};
                            const isGroup = chatData.isGroup === true;

                            const reactorDoc = await db.collection('users').doc(reactorUid).get();
                            const reactorInfo = reactorDoc.data() || {};
                            let reactorName = reactorInfo.name || reactorInfo.username || "Someone";
                            const reactorPhoto = reactorInfo.photoURL || "https://www.goorac.biz/icon.png";
                            const reactorUsername = reactorInfo.username || reactorUid;

                            if (isGroup) reactorName = `${reactorName} in ${chatData.groupName || 'Group'}`;

                            const title = isGroup ? reactorName : `New Reaction`;
                            const body = `${isGroup ? reactorName.split(' ')[0] : reactorName} reacted ${reactionData.emoji} to your message.`;

                            const deepLink = isGroup 
                                ? `https://www.goorac.biz/groupChat.html?id=${chatDocId}` 
                                : `https://www.goorac.biz/chat.html?user=${reactorUsername}`;

                            await beamsClient.publishToInterests([messageOwner], {
                                web: { notification: { title: title, body: body, icon: reactorPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: true }, time_to_live: 3600 },
                                fcm: { notification: { title: title, body: body, icon: reactorPhoto }, data: { click_action: deepLink }, priority: "high" },
                                apns: { aps: { alert: { title: title, body: body }, "thread-id": chatDocId }, headers: { "apns-priority": "10", "apns-push-type": "alert" } }
                            });
                        }
                    } catch (err) { console.error("❌ Reaction Push Error:", err); }
                }
            }
        });
    }, (error) => { console.error("❌ Messages listener error:", error); });
}

// ============================================================================
// LISTENER 2: LIKES, COMMENTS, DROPS, AND NOTES (Notifications Collection)
// ============================================================================
function startNotificationListener() {
    console.log("🎧 Listening for Likes, Comments, Drops, and Notes...");

    db.collection('notifications').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            
            if (change.type === 'added') {
                const docId = change.doc.id;
                const notifData = change.doc.data();
                
                // BULLETPROOF TIMESTAMP: Combines logic securely 
                let msgTime = 0;
                if (change.doc.createTime) msgTime = change.doc.createTime.toMillis();
                else if (notifData.timestamp && notifData.timestamp.toMillis) msgTime = notifData.timestamp.toMillis();
                else if (notifData.timestamp) msgTime = new Date(notifData.timestamp).getTime();

                // Process strictly if event was logged in the last 2 minutes
                if (!msgTime || Date.now() - msgTime > 120000) return;

                if (processedNotifs.has(docId)) return;
                processedNotifs.add(docId);
                setTimeout(() => processedNotifs.delete(docId), 180000); 

                // BULLETPROOF ID CHECKER
                const targetUid = notifData.toUid || notifData.targetUid || notifData.receiverId || notifData.ownerId;
                const senderUid = notifData.fromUid || notifData.senderUid || notifData.userId || notifData.sender;
                
                if (!targetUid || targetUid === senderUid) return; 

                try {
                    const senderDoc = await db.collection('users').doc(senderUid).get();
                    const senderData = senderDoc.data() || {};
                    const senderName = senderData.name || senderData.username || notifData.senderName || notifData.fromName || "Someone";
                    const senderPhoto = senderData.photoURL || notifData.senderPfp || notifData.fromPfp || "https://www.goorac.biz/icon.png";
                    
                    const deepLink = notifData.link || notifData.targetUrl || `https://www.goorac.biz/notifications.html`;

                    let title = "New Notification";
                    let body = ""; 

                    const textContent = notifData.text || notifData.body || notifData.message || notifData.comment || "";
                    const type = (notifData.type || "").toLowerCase();
                    const linkString = deepLink.toLowerCase();

                    // --- 1. HANDLE LIKES ---
                    // Added safety catch properties for "noteId" specifically to catch missing types
                    if (type.includes('like')) {
                        title = `New Like ❤️`;
                        if (type === 'note_like' || linkString.includes('note') || notifData.noteId) body = `${senderName} liked your Note.`;
                        else if (type === 'drop_like' || linkString.includes('drop')) body = `${senderName} liked your Drop.`;
                        else if (type === 'like_moment' || linkString.includes('moment')) body = `${senderName} liked your Moment.`;
                        else body = `${senderName} liked your post.`;
                    } 
                    // --- 2. HANDLE REPLIES & COMMENTS ---
                    else if (type.includes('reply') || type.includes('comment')) {
                        title = `New Reply 💬`;
                        if (type === 'drop_reply' || linkString.includes('drop')) {
                             body = textContent ? `${senderName} replied to your Drop: "${textContent}"` : `${senderName} replied to your Drop.`;
                        } else if (type === 'note_reply' || linkString.includes('note') || notifData.noteId) {
                             body = textContent ? `${senderName} replied to your Note: "${textContent}"` : `${senderName} replied to your Note.`;
                        } else if (type === 'reply_moment' || type === 'comment_moment') {
                             body = textContent ? `${senderName} ${textContent}` : `${senderName} commented on your Moment.`;
                        } else {
                             body = textContent ? `${senderName} commented: "${textContent}"` : `${senderName} commented on your post.`;
                        }
                    } 
                    // --- 3. FALLBACK ---
                    else {
                        body = textContent || "Check your activity feed.";
                    }

                    await beamsClient.publishToInterests([targetUid], {
                        web: { notification: { title: title, body: body, icon: senderPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: true }, time_to_live: 3600 },
                        fcm: { notification: { title: title, body: body, icon: senderPhoto }, data: { click_action: deepLink }, priority: "high" },
                        apns: { aps: { alert: { title: title, body: body }, "thread-id": "notifications" }, headers: { "apns-priority": "10", "apns-push-type": "alert" } }
                    });
                    console.log(`✅ Event Push sent to ${targetUid} for type: ${type}`);

                } catch (error) { console.error("❌ Notification Push Error:", error); }
            }
        });
    }, (error) => { console.error("❌ Notifications listener error:", error); });
}

// ============================================================================
// LISTENER 3: AUDIO AND VIDEO CALLS
// ============================================================================
function startCallListener() {
    console.log("🎧 Listening for Incoming and Missed Calls...");

    // 1. INCOMING CALLS
    db.collection('calls').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const callData = change.doc.data();
                if (callData.status !== 'calling') return;

                let msgTime = 0;
                if (change.doc.updateTime) msgTime = change.doc.updateTime.toMillis();
                else if (change.doc.createTime) msgTime = change.doc.createTime.toMillis();

                if (!msgTime || Date.now() - msgTime > 60000) return; // Ignore calls ringing longer than 1 min

                const targetUid = change.doc.id; 
                const callerUid = callData.callerId;
                if (!targetUid || !callerUid) return;

                const throttleKey = `call_${targetUid}_${callerUid}`;
                if (processedNotifs.has(throttleKey)) return;
                processedNotifs.add(throttleKey);
                setTimeout(() => processedNotifs.delete(throttleKey), 45000); 

                try {
                    const callerDoc = await db.collection('users').doc(callerUid).get();
                    const callerInfo = callerDoc.data() || {};
                    const callerName = callerInfo.name || callerInfo.username || callData.callerName || "Someone";
                    const callerPhoto = callerInfo.photoURL || callData.callerPfp || "https://www.goorac.biz/icon.png";
                    
                    const isVideo = callData.type === 'video';

                    const title = isVideo ? "Incoming Video Call 🎥" : "Incoming Audio Call 📞";
                    const body = `${callerName} is calling you... Tap to answer.`;
                    const deepLink = `https://www.goorac.biz/calls.html`;

                    await beamsClient.publishToInterests([targetUid], {
                        web: { notification: { title, body, icon: callerPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: true }, time_to_live: 60 },
                        fcm: { notification: { title, body, icon: callerPhoto }, data: { click_action: deepLink }, priority: "high" },
                        apns: { aps: { alert: { title, body }, "thread-id": "calls" }, headers: { "apns-priority": "10", "apns-push-type": "alert" } }
                    });
                    console.log(`✅ Incoming Call Push sent to ${targetUid}`);
                } catch (e) { console.error("❌ Call Push Error:", e); }
            }
        });
    }, (error) => { console.error("❌ Calls listener error:", error); });

    // 2. MISSED CALLS
    db.collection('call_logs').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            
            let msgTime = 0;
            if (change.doc.createTime) msgTime = change.doc.createTime.toMillis();

            if (!msgTime || Date.now() - msgTime > 120000) return;

            if (change.type === 'added') {
                const logData = change.doc.data();
                if (logData.status !== 'missed') return; 

                const targetUid = logData.receiverId;
                const callerUid = logData.callerId;
                if (!targetUid || targetUid === callerUid) return;

                const docId = change.doc.id;
                if (processedNotifs.has(docId)) return;
                processedNotifs.add(docId);
                setTimeout(() => processedNotifs.delete(docId), 180000);

                try {
                    const callerDoc = await db.collection('users').doc(callerUid).get();
                    const callerInfo = callerDoc.data() || {};
                    const callerName = callerInfo.name || callerInfo.username || logData.callerName || "Someone";
                    const callerPhoto = callerInfo.photoURL || logData.callerPfp || "https://www.goorac.biz/icon.png";
                    
                    const isVideo = logData.type === 'video';

                    const title = "Missed Call 📵";
                    const body = `You missed a ${isVideo ? 'video' : 'voice'} call from ${callerName}.`;
                    const deepLink = `https://www.goorac.biz/calls.html`;

                    await beamsClient.publishToInterests([targetUid], {
                        web: { notification: { title, body, icon: callerPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: true }, time_to_live: 3600 },
                        fcm: { notification: { title, body, icon: callerPhoto }, data: { click_action: deepLink }, priority: "high" },
                        apns: { aps: { alert: { title, body }, "thread-id": "calls" }, headers: { "apns-priority": "10", "apns-push-type": "alert" } }
                    });
                    console.log(`✅ Missed Call Push sent to ${targetUid}`);
                } catch (e) { console.error("❌ Missed Call Push Error:", e); }
            }
        });
    }, (error) => { console.error("❌ Call Logs listener error:", error); });
}

// Export all listeners wrapped in a single starter function
function startPushListener() {
    startMessageListener();
    startNotificationListener();
    startCallListener(); 
}

// Render and other services provide the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Goorac push server is live and listening on port ${port}`);
  
  // Start the Firebase background listeners when the server boots
  startPushListener();
});

require('./server.js');
