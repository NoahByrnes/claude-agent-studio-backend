# Connector Setup Guide

This guide explains how to set up Email (SendGrid) and SMS (Twilio) connectors for your Claude Agent Studio.

---

## 📧 SendGrid Email Setup

### 1. Create SendGrid Account

1. Go to https://sendgrid.com/
2. Sign up for a free account (100 emails/day free forever)
3. Verify your email address

### 2. Generate API Key

1. Go to Settings → API Keys
2. Click "Create API Key"
3. Name: `Claude Agent Studio`
4. Permission: **Full Access** (or at minimum: Mail Send + Inbound Parse)
5. Copy the API key (starts with `SG.`)

### 3. Configure Inbound Parse

This allows your agent to receive emails:

1. Go to Settings → Inbound Parse
2. Click "Add Host & URL"
3. Choose a subdomain (e.g., `agent`) and your domain
   - If you don't have a domain, use SendGrid's test domain
4. Set URL: `https://backend-api-production-8b0b.up.railway.app/api/webhooks/email`
5. Check "POST the raw, full MIME message"
6. Save

### 4. Set Up Domain Authentication (Recommended)

For better deliverability:

1. Go to Settings → Sender Authentication
2. Click "Authenticate Your Domain"
3. Follow the DNS setup instructions
4. Wait for verification (can take up to 48 hours)

### 5. Configure Railway Environment Variables

Add these to your Railway project:

```bash
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM_EMAIL=agent@yourdomain.com
```

### 6. Test Email

Send an email to the inbound address (e.g., `agent@yourdomain.com`).

The conductor should receive it and respond automatically!

---

## 📱 Twilio SMS Setup

### 1. Create Twilio Account

1. Go to https://twilio.com/
2. Sign up for a free trial
3. Verify your phone number

### 2. Get Phone Number

1. Go to Phone Numbers → Manage → Buy a number
2. Choose a number that supports SMS
   - Free trial includes one phone number
3. Purchase/assign the number

### 3. Get Account Credentials

1. Go to Console Dashboard
2. Copy your **Account SID** and **Auth Token**

### 4. Configure SMS Webhook

1. Go to Phone Numbers → Manage → Active Numbers
2. Click on your number
3. Scroll to "Messaging Configuration"
4. Set "A MESSAGE COMES IN" webhook:
   - URL: `https://backend-api-production-8b0b.up.railway.app/api/webhooks/sms`
   - HTTP POST
5. Save

### 5. Configure Railway Environment Variables

Add these to your Railway project:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1234567890
```

### 6. Test SMS

Send a text message to your Twilio number.

The conductor should receive it and respond automatically!

---

## 🔍 Verify Configuration

### Check Connector Status

```bash
curl https://backend-api-production-8b0b.up.railway.app/api/monitoring/connectors
```

Should return:

```json
{
  "email": {
    "configured": true,
    "fromAddress": "agent@yourdomain.com"
  },
  "sms": {
    "configured": true,
    "phoneNumber": "+1234567890"
  }
}
```

### Test End-to-End

**Email:**
```bash
# Send email to your inbound address
echo "Create a file at /tmp/test.txt" | mail -s "Test Task" agent@yourdomain.com
```

**SMS:**
```
# Send text to your Twilio number
Text: "What's the weather in San Francisco?"
```

---

## 💡 Tips

### Email Best Practices

- Use a dedicated subdomain for agent emails (e.g., `agent.yourdomain.com`)
- Set up DMARC/SPF/DKIM for better deliverability
- Monitor SendGrid dashboard for bounces and spam reports

### SMS Best Practices

- Twilio free trial has limitations (only send to verified numbers)
- Upgrade to paid account for production use
- Be mindful of SMS length (160 characters = 1 SMS segment)
- Use SMS for brief updates, email for detailed responses

### Cost Considerations

**SendGrid:**
- Free: 100 emails/day
- Essentials: $15/month for 50,000 emails/month
- Pro: $90/month for 100,000 emails/month

**Twilio:**
- SMS: ~$0.0075 per message (US)
- Phone number: $1/month
- Free trial includes $15 credit

---

## 🚨 Troubleshooting

### Email Not Received

1. Check Railway logs: `railway logs`
2. Verify SendGrid webhook URL is correct
3. Test webhook manually:
   ```bash
   curl -X POST https://backend-api-production-8b0b.up.railway.app/api/webhooks/email \
     -H "Content-Type: application/json" \
     -d '{"from":"test@example.com","subject":"Test","text":"Hello"}'
   ```
4. Check SendGrid activity feed for delivery errors

### SMS Not Received

1. Check Railway logs
2. Verify Twilio webhook URL is correct
3. Test webhook manually:
   ```bash
   curl -X POST https://backend-api-production-8b0b.up.railway.app/api/webhooks/sms \
     -H "Content-Type: application/json" \
     -d '{"From":"+1234567890","Body":"Test message"}'
   ```
4. Check Twilio console for SMS logs

### Responses Not Sending

1. Check Railway environment variables are set
2. Verify API keys are valid
3. Check Railway logs for error messages
4. Test messaging service directly in Railway console

---

## 📚 Next Steps

Once connectors are configured:

1. Set up the Studio UI to manage connector settings
2. Add email templates for better formatting
3. Configure auto-responders and routing rules
4. Set up conversation memory for context retention

---

**Need Help?** Check Railway logs or SendGrid/Twilio dashboards for detailed error messages.
