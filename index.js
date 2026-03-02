const express = require('express');
const cors = require('cors');
const PushNotifications = require('@pusher/push-notifications-server');

const app = express();

// Allows your Goorac frontend to talk to this server without CORS errors
app.use(cors()); 
app.use(express.json());

// A simple home route to check if the server is alive
app.get('/', (req, res) => {
  res.send('Goorac Push Server is Online and Permanent!');
});

// Initialize Pusher Beams
const beamsClient = new PushNotifications({
  instanceId: '66574b98-4518-443c-9245-7a3bd9ac0ab7',
  secretKey: '99DC07D1A9F9B584F776F46A3353B3C3FC28CB53EFE8B162D57EBAEB37669A6A' 
});

// The endpoint your chat app will call to trigger a notification
app.post('/send-push', (req, res) => {
  // Added 'icon' to the destructuring so we can receive the profile picture URL
  const { targetUid, title, body, icon } = req.body;

  beamsClient.publishToInterests([targetUid], {
    web: {
      notification: {
        title: title,
        body: body,
        // Added 'icon' here to display the sender's PFP in the notification banner
        icon: icon,
        deep_link: "https://www.goorac.biz"
      },
      // Hides notification if the user is currently looking at the chat
      hide_notification_if_site_has_focus: true
    }
  })
  .then((publishResponse) => {
    console.log('Successfully sent notification to:', targetUid);
    res.json({ success: true, publishResponse });
  })
  .catch((error) => {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: error.message });
  });
});

// Render and other services provide the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Push server is live and listening on port ${port}`);
});
