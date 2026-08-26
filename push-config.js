/* MOAQIB V6 — OPTIONAL WEB/PWA PUSH CONFIGURATION
   ---------------------------------------------------------------
   - This public file may contain ONLY the VAPID PUBLIC key.
   - NEVER put the VAPID private key or Supabase service-role key here.
*/
window.MOAQIB_PUSH_CONFIG = {
  enabled: false,
  vapidPublicKey: '',
  subscriptionTable: 'push_subscriptions',
  functionName: 'send-reminders'
};
