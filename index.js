const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const PushNotifications = require('@pusher/push-notifications-server');

const app = express();

// --- THE ULTIMATE ANTI-SPAM CLOCK ---
const SERVER_START_TIME = Date.now(); 

const processedMessages = new Set();
const processedNotifs = new Set();

app.use(cors()); 
app.use(express.json());

app.get('/', (req, res) => res.send('Goorac Push Server is Online!'));
app.get('/ping', (req, res) => res.status(200).send('Pong! Server is awake.'));

// 1. Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
    console.log("🎧 Listening for Chat Messages & Reactions...");

    db.collectionGroup('messages').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            const messageData = change.doc.data();
            const docId = change.doc.id;
            
            // --- A. NEW MESSAGES & REPLIES ---
            if (change.type === 'added') {
                const msgCreateTime = change.doc.createTime ? change.doc.createTime.toMillis() : Date.now();
                
                if (Date.now() - msgCreateTime > 60000 || msgCreateTime <= SERVER_START_TIME) return; 
                if (processedMessages.has(docId)) return;
                
                processedMessages.add(docId);
                setTimeout(() => processedMessages.delete(docId), 86400000); 

                setTimeout(async () => {
                    try {
                        const senderUid = String(messageData.sender || "").trim();
                        if (!senderUid) return; 

                        const chatRef = change.doc.ref.parent.parent;
                        if (!chatRef) return; // Failsafe if message is somehow at root level
                        
                        const chatDocId = chatRef.id;
                        const chatDoc = await chatRef.get();
                        const chatData = chatDoc.exists ? chatDoc.data() : {};
                        const isGroup = chatData.isGroup === true;
                        
                        let targetUids = isGroup 
                            ? (chatData.participants || []).filter(uid => String(uid).trim() !== senderUid)
                            : (chatDocId.split('_').length === 2 ? [chatDocId.split('_')[0] === senderUid ? chatDocId.split('_')[1] : chatDocId.split('_')[0]] : (chatData.participants || []).filter(uid => String(uid).trim() !== senderUid));

                        targetUids = [...new Set(targetUids)];
                        if (targetUids.length === 0) return; 
                        
                        const senderDoc = await db.collection('users').doc(senderUid).get();
                        const senderData = senderDoc.data() || {};
                        let senderName = senderData.name || senderData.username || "Someone";
                        const senderPhoto = senderData.photoURL || "https://www.goorac.biz/icon.png";
                        const senderUsername = senderData.username || senderUid;

                        if (isGroup) senderName = `${senderName} in ${chatData.groupName || 'Group'}`;

                        let bodyText = messageData.text || "New message";
                        if (messageData.isHtml || messageData.isDropReply || messageData.replyToNote) bodyText = "💬 Replied to your post";
                        else if (messageData.isBite) bodyText = "🎬 Sent a Bite video";
                        else if (messageData.isGif) bodyText = "🎞️ Sent a GIF";
                        else if (messageData.imageUrl) bodyText = "📷 Sent an image";
                        else if (messageData.fileMeta?.type?.includes('audio')) bodyText = "🎵 Sent a voice message";
                        else if (messageData.fileUrl) bodyText = "📎 Sent an attachment";

                        const deepLink = isGroup ? `https://www.goorac.biz/groupChat.html?id=${chatDocId}` : `https://www.goorac.biz/chat.html?user=${senderUsername}`;

                        targetUids.forEach(async (targetUid) => {
                            try {
                                const targetDoc = await db.collection('users').doc(targetUid).get();
                                const targetActiveChat = targetDoc.data()?.activeChat;
                                if (targetActiveChat === senderUid || targetActiveChat === senderUsername || targetActiveChat === chatDocId) return;

                                await beamsClient.publishToInterests([targetUid], {
                                    web: { notification: { title: senderName, body: bodyText, icon: senderPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: false } },
                                    fcm: { notification: { title: senderName, body: bodyText, icon: senderPhoto }, data: { click_action: deepLink } },
                                    apns: { aps: { alert: { title: senderName, body: bodyText }, "thread-id": chatDocId } }
                                });
                            } catch(e) { console.error("Push Error", e); }
                        });
                    } catch (error) { console.error("❌ Message Push Error:", error); }
                }, 1500); 
            }

            // --- B. MESSAGE REACTIONS ---
            if (change.type === 'modified' && messageData.reactions) {
                try {
                    const messageOwner = String(messageData.sender || "").trim(); 
                    if (!messageOwner) return;

                    for (const [reactorUid, reactionData] of Object.entries(messageData.reactions)) {
                        const safeReactorUid = String(reactorUid).trim();
                        if (safeReactorUid === messageOwner) continue; 
                        
                        // NOTE: If your client app doesn't save a timestamp with reactions, this will skip them!
                        if (!reactionData.timestamp || Date.now() - reactionData.timestamp > 60000) continue; 

                        const reactionCacheKey = `reaction_${docId}_${safeReactorUid}_${reactionData.emoji}`;
                        if (processedMessages.has(reactionCacheKey)) continue;
                        
                        processedMessages.add(reactionCacheKey);
                        setTimeout(() => processedMessages.delete(reactionCacheKey), 86400000); 

                        const chatRef = change.doc.ref.parent.parent;
                        const chatDocId = chatRef.id;
                        
                        const ownerDoc = await db.collection('users').doc(messageOwner).get();
                        if (ownerDoc.data()?.activeChat === safeReactorUid || ownerDoc.data()?.activeChat === chatDocId) continue;

                        const reactorDoc = await db.collection('users').doc(safeReactorUid).get();
                        const reactorInfo = reactorDoc.data() || {};
                        let reactorName = reactorInfo.name || reactorInfo.username || "Someone";
                        const reactorPhoto = reactorInfo.photoURL || "https://www.goorac.biz/icon.png";
                        
                        const chatDoc = await chatRef.get();
                        const chatData = chatDoc.exists ? chatDoc.data() : {};
                        if (chatData.isGroup) reactorName = `${reactorName} in ${chatData.groupName || 'Group'}`;

                        const title = chatData.isGroup ? reactorName : `New Reaction`;
                        const body = `${chatData.isGroup ? reactorName.split(' ')[0] : reactorName} reacted ${reactionData.emoji} to your message.`;
                        const deepLink = chatData.isGroup ? `https://www.goorac.biz/groupChat.html?id=${chatDocId}` : `https://www.goorac.biz/chat.html?user=${reactorInfo.username || safeReactorUid}`;

                        await beamsClient.publishToInterests([messageOwner], {
                            web: { notification: { title, body, icon: reactorPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: false } },
                            fcm: { notification: { title, body, icon: reactorPhoto }, data: { click_action: deepLink } },
                            apns: { aps: { alert: { title, body }, "thread-id": chatDocId } }
                        });
                    }
                } catch (err) { console.error("❌ Reaction Push Error:", err); }
            }
        });
    }, (error) => console.error("❌ Messages listener error:", error));
}

// ============================================================================
// LISTENER 2: NOTIFICATIONS (LIKES, COMMENTS, ETC)
// ============================================================================
function startNotificationListener() {
    console.log("🎧 Listening for Feed Notifications...");

    db.collection('notifications').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added') {
                const notifData = change.doc.data();
                const docId = change.doc.id;
                const type = (notifData.type || "").toLowerCase();
                
                // 🔥 THE DOUBLE-PUSH FIX: Ignore notification types that are already pushed by Listener 1 
                if (['message', 'chat', 'drop_reply', 'note_reply'].includes(type)) {
                    return; 
                }

                let msgCreateTime = SERVER_START_TIME;
                if (change.doc.createTime) msgCreateTime = change.doc.createTime.toMillis();
                else if (notifData.timestamp && notifData.timestamp.toMillis) msgCreateTime = notifData.timestamp.toMillis();
                else if (notifData.timestamp) msgCreateTime = new Date(notifData.timestamp).getTime();

                if (Date.now() - msgCreateTime > 60000 || msgCreateTime <= SERVER_START_TIME) return;
                if (processedNotifs.has(docId)) return;
                processedNotifs.add(docId);
                setTimeout(() => processedNotifs.delete(docId), 86400000); 

                // 🔥 THE "UNDEFINED" FIX: Prevents String() from coercing undefined into the word "undefined"
                const rawTarget = notifData.toUid || notifData.targetUid || notifData.receiverId || notifData.ownerId;
                const rawSender = notifData.fromUid || notifData.senderUid || notifData.userId || notifData.sender;
                
                if (!rawTarget || !rawSender) return; 

                const targetUid = String(rawTarget).trim();
                const senderUid = String(rawSender).trim();
                if (targetUid === senderUid || targetUid === "undefined") return; 

                try {
                    const senderDoc = await db.collection('users').doc(senderUid).get();
                    const senderData = senderDoc.data() || {};
                    const senderName = senderData.name || senderData.username || notifData.senderName || notifData.fromName || "Someone";
                    const senderPhoto = senderData.photoURL || notifData.senderPfp || notifData.fromPfp || "https://www.goorac.biz/icon.png";
                    const deepLink = notifData.link || notifData.targetUrl || `https://www.goorac.biz/notifications.html`;
                    const linkString = deepLink.toLowerCase();

                    let title = "New Notification";
                    let body = notifData.text || notifData.body || notifData.message || notifData.comment || "Check your activity feed."; 

                    if (type.includes('like')) {
                        title = `New Like ❤️`;
                        if (type === 'note_like' || linkString.includes('note')) body = `${senderName} liked your Note.`;
                        else if (type === 'drop_like' || linkString.includes('drop')) body = `${senderName} liked your Drop.`;
                        else if (type === 'like_moment' || linkString.includes('moment')) body = `${senderName} liked your Moment.`;
                        else body = `${senderName} liked your post.`;
                    } 
                    else if (type.includes('reply') || type.includes('comment')) {
                        title = `New Reply 💬`;
                        const textContent = notifData.text || notifData.comment;
                        if (type === 'drop_comment' || linkString.includes('drop')) body = textContent ? `${senderName} commented on your Drop: "${textContent}"` : `${senderName} commented on your Drop.`;
                        else body = textContent ? `${senderName} commented: "${textContent}"` : `${senderName} commented on your post.`;
                    } 

                    await beamsClient.publishToInterests([targetUid], {
                        web: { notification: { title, body, icon: senderPhoto, deep_link: deepLink, hide_notification_if_site_has_focus: false } },
                        fcm: { notification: { title, body, icon: senderPhoto }, data: { click_action: deepLink } },
                        apns: { aps: { alert: { title, body }, "thread-id": "notifications" } }
                    });
                } catch (error) { console.error("❌ Notification Push Error:", error); }
            }
        });
    }, (error) => console.error("❌ Notifications listener error:", error));
}

// ============================================================================
// LISTENER 3: AUDIO AND VIDEO CALLS
// ============================================================================
function startCallListener() {
    console.log("🎧 Listening for Incoming and Missed Calls...");

    db.collection('calls').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const callData = change.doc.data();
                if (callData.status !== 'calling') return; 

                const msgUpdateTime = change.doc.updateTime ? change.doc.updateTime.toMillis() : Date.now();
                if (Date.now() - msgUpdateTime > 60000 || msgUpdateTime <= SERVER_START_TIME) return;

                const targetUid = String(change.doc.id).trim(); 
                const callerUid = String(callData.callerId).trim();
                if (!targetUid || !callerUid || targetUid === callerUid || targetUid === "undefined") return;

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
                    
                    await beamsClient.publishToInterests([targetUid], {
                        web: { notification: { title, body, icon: callerPhoto, deep_link: `https://www.goorac.biz/calls.html`, hide_notification_if_site_has_focus: false } }, 
                        fcm: { notification: { title, body, icon: callerPhoto }, data: { click_action: `https://www.goorac.biz/calls.html` } },
                        apns: { aps: { alert: { title, body }, "thread-id": "calls" } }
                    });
                } catch (e) { console.error("❌ Call Push Error:", e); }
            }
        });
    }, (error) => console.error("❌ Calls listener error:", error));
}

function startPushListener() {
    startMessageListener();
    startNotificationListener();
    startCallListener(); 
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Goorac push server is live and listening on port ${port}`);
  startPushListener();
});

// require('./server.js'); // ⚠️ I COMMENTED THIS OUT! Read the notes below.
