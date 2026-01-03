/**
 * Generate VAPID Keys for Push Notifications
 * Run this script to generate VAPID keys for your application
 * 
 * Usage: node generate-vapid-keys.js
 */

const webpush = require('web-push');

console.log('🔑 Generating VAPID keys...\n');

// Generate VAPID keys
const vapidKeys = webpush.generateVAPIDKeys();

console.log('✅ VAPID Keys Generated!\n');
console.log('Add these to your .env file:\n');
console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
console.log('VAPID_SUBJECT=mailto:your-email@example.com\n');
console.log('⚠️  Replace "your-email@example.com" with your actual email address!\n');
console.log('📋 Copy the keys above and add them to your .env file in the backend directory.');

