const PushNotifications = require('@pusher/push-notifications-server');
const cron = require('node-cron');

// Initialize Pusher Beams
const beamsClient = new PushNotifications({
  instanceId: '66574b98-4518-443c-9245-7a3bd9ac0ab7',
  secretKey: '99DC07D1A9F9B584F776F46A3353B3C3FC28CB53EFE8B162D57EBAEB37669A6A' 
});

const iconUrl = "https://github.com/corporationgoorac/Goorac/raw/refs/heads/main/images/icon.png";
const clickUrl = "https://www.goorac.biz/home.html";

// --- MESSAGE BANKS ---

const morningMessages = [
  "Good morning! What's on your mind? Post a note now.",
  "Rise and shine! Share your first thought of the day on Quantum.",
  "Good morning! Set the tone for your day with a new note.",
  "Wakey wakey! The Quantum network is waiting for your morning vibe.",
  "A fresh day begins! What are your goals today? Drop a note.",
  "Good morning! Got any wild dreams to share before you forget them?",
  "Start your day right. Post a quick morning update!",
  "Good morning! Coffee in hand? Time to check in on Quantum.",
  "New morning, new moment. What's happening in your world?",
  "Morning! The dashboard is empty without your daily note."
];

const afternoonMessages = [
  "Halfway there! How's your day going? Drop a note.",
  "Lunchtime! Take a break and share a moment on Quantum.",
  "Good afternoon! Need a midday reset? Post what's on your mind.",
  "Afternoon check-in! Keep your network updated.",
  "Hope your day is productive! Take a second to share a note.",
  "Midday slump? Wake up your friends with a new Quantum post.",
  "Good afternoon! What's the highlight of your day so far?",
  "Take a breather. What are you up to this afternoon?",
  "Afternoon vibes! Share a quick update with the network.",
  "Just checking in! Drop a midday note for your friends."
];

const eveningMessages = [
  "Good evening! How was your day? Post a note.",
  "Winding down? Share your final thoughts of the day on Quantum.",
  "Good evening! Time to reflect—drop a note about your day.",
  "The day is almost over. What was your best moment?",
  "Evening check-in! Let your network know how today went.",
  "Relax and unwind. Share a chill evening note.",
  "Good evening! Got any late-night thoughts to post?",
  "Wrapping up the day? Leave a note for your friends to wake up to.",
  "Sunset vibes. What's on your mind tonight?",
  "Good evening! Summarize your day in a single Quantum note."
];

// --- BROADCAST FUNCTION ---
function sendBroadcast(message) {
  beamsClient.publishToInterests(['hello'], {
    web: {
      notification: {
        title: "Quantum",
        body: message,
        icon: iconUrl,
        deep_link: clickUrl,
        hide_notification_if_site_has_focus: false
      }
    },
    fcm: {
      notification: {
        title: "Quantum",
        body: message,
        icon: iconUrl
      },
      data: {
        click_action: clickUrl
      },
      priority: "high"
    },
    apns: {
      aps: {
        alert: {
          title: "Quantum",
          body: message
        }
      },
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert"
      }
    }
  })
  .then((publishResponse) => {
    console.log(`✅ Broadcast Sent: "${message}" | ID: ${publishResponse.publishId}`);
  })
  .catch((error) => {
    console.error('❌ Error sending notification:', error);
  });
}

// --- OFFICIAL DAILY SCHEDULES ---

// 1. Morning Schedule (6:45 AM)
cron.schedule('45 6 * * *', () => {
  const randomMsg = morningMessages[Math.floor(Math.random() * morningMessages.length)];
  sendBroadcast(randomMsg);
}, { timezone: "Asia/Kolkata" });

// 2. Afternoon Schedule (12:30 PM)
cron.schedule('30 12 * * *', () => {
  const randomMsg = afternoonMessages[Math.floor(Math.random() * afternoonMessages.length)];
  sendBroadcast(randomMsg);
}, { timezone: "Asia/Kolkata" });

// 3. Evening Schedule (7:30 PM / 19:30)
cron.schedule('30 19 * * *', () => {
  const randomMsg = eveningMessages[Math.floor(Math.random() * eveningMessages.length)];
  sendBroadcast(randomMsg);
}, { timezone: "Asia/Kolkata" });

console.log('⏳ Goorac Quantum Scheduled Notification Service is running...');

// =====================================================================
// --- TEST ZONE (Delete or comment this out after confirming it works) ---
// =====================================================================

// Test 1: Fire a test notification 3 seconds after the server starts
setTimeout(() => {
  console.log("🛠️ Firing instant test notification...");
  sendBroadcast("🛠️ Test: Server is online and Pusher is working!");
}, 3000);

// Test 2: Fire a test notification every 1 minute
cron.schedule('* * * * *', () => {
  console.log("⏱️ Firing 1-minute test cron...");
  sendBroadcast("⏱️ Test: This is your 1-minute recurring test!");
}, { timezone: "Asia/Kolkata" });
