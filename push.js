const admin = require('firebase-admin');

// 1. Initialize Firebase Admin SDK safely
if (!admin.apps.length) {
    try {
        // This pulls the massive JSON you pasted into the Render dashboard
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ Firebase Admin initialized successfully in push.js");
    } catch (error) {
        console.error("❌ Failed to initialize Firebase Admin. Check FIREBASE_SERVICE_ACCOUNT env var.", error);
    }
}

const db = admin.firestore();

// 2. The Main Background Listener
function startPushListener() {
    console.log("🎧 Quantum Push Listener activated: Listening for new messages...");

    // db.collectionGroup listens to ALL 'messages' subcollections across every chat
    db.collectionGroup('messages').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            
            // We ONLY care about BRAND NEW messages being added
            if (change.type === 'added') {
                const messageData = change.doc.data();
                
                // --- SAFETY CHECKS ---
                // Ignore messages without a timestamp
                if (!messageData.timestamp) return;
                
                // Prevent spam on server reboot: If message is older than 2 mins, ignore it.
                const msgTime = messageData.timestamp.toMillis ? messageData.timestamp.toMillis() : new Date(messageData.timestamp).getTime();
                if (Date.now() - msgTime > 120000) return;

                try {
                    const senderUid = messageData.sender;
                    
                    // --- FIND THE RECIPIENT ---
                    // Path is: chats/{chatId}/messages/{messageId}
                    // Using parent.parent gets us the main chat document to see who is in the room
                    const chatRef = change.doc.ref.parent.parent;
                    const chatDoc = await chatRef.get();
                    
                    if (!chatDoc.exists) return;
                    
                    const chatData = chatDoc.data();
                    const participants = chatData.participants || [];
                    
                    // The target is the participant who is NOT the sender
                    const targetUid = participants.find(uid => uid !== senderUid);
                    if (!targetUid) return;

                    // --- FETCH RECIPIENT TOKEN ---
                    const targetDoc = await db.collection('users').doc(targetUid).get();
                    const targetData = targetDoc.data();
                    const fcmToken = targetData?.fcmToken;

                    if (!fcmToken) {
                        console.log(`⚠️ User ${targetUid} has no FCM token. Skipping push.`);
                        return; 
                    }

                    // --- FETCH SENDER INFO ---
                    const senderDoc = await db.collection('users').doc(senderUid).get();
                    const senderData = senderDoc.data() || {};
                    const senderName = senderData.name || senderData.username || "Someone";
                    const senderPhoto = senderData.photoURL || "https://www.goorac.biz/icon.png";
                    const senderUsername = senderData.username || senderUid;

                    // --- FORMAT THE TEXT ---
                    // Automatically adjusts based on what kind of message it is
                    let bodyText = messageData.text || "New message";
                    if (messageData.isBite) bodyText = "🎬 Sent a Bite video";
                    else if (messageData.isGif) bodyText = "🎞️ Sent a GIF";
                    else if (messageData.imageUrl) bodyText = "📷 Sent an image";
                    else if (messageData.fileMeta && messageData.fileMeta.type && messageData.fileMeta.type.includes('audio')) bodyText = "🎵 Sent a voice message";
                    else if (messageData.fileUrl) bodyText = "📎 Sent an attachment";

                    // --- SEND THE PAYLOAD ---
                    const payload = {
                        notification: {
                            title: senderName,
                            body: bodyText,
                        },
                        webpush: {
                            notification: {
                                icon: senderPhoto,
                                click_action: `https://www.goorac.biz/chat.html?user=${senderUsername}`
                            }
                        },
                        token: fcmToken
                    };

                    await admin.messaging().send(payload);
                    console.log(`✅ Push successfully sent to ${targetUid} from ${senderName}`);

                } catch (error) {
                    console.error("❌ Error processing push notification:", error);
                }
            }
        });
    }, (error) => {
        console.error("❌ Firestore listener critical error:", error);
    });
}

// Export the function so your main server can turn it on
module.exports = { startPushListener };
