const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Contact form email configuration
const CONTACT_EMAIL = 'cellspott.aa@gmail.com';

// Create reusable transporter (using Gmail as example - configure based on your email service)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Your email address (e.g., your-email@gmail.com)
        pass: process.env.EMAIL_PASSWORD // Your email app password or password
    }
});

// Alternative: Use SMTP configuration (uncomment and configure if not using Gmail)
// const transporter = nodemailer.createTransport({
//     host: process.env.SMTP_HOST,
//     port: process.env.SMTP_PORT || 587,
//     secure: false, // true for 465, false for other ports
//     auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASSWORD
//     }
// });

// Contact form submission endpoint
router.post('/contact', async (req, res) => {
    try {
        const { name, email, message } = req.body;

        // Validate input
        if (!name || !email || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Name, email, and message are required' 
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid email format' 
            });
        }

        // Email content
        const mailOptions = {
            from: process.env.EMAIL_USER || 'noreply@cellspott.com',
            to: CONTACT_EMAIL,
            replyTo: email, // Allow replying directly to the sender
            subject: `Contact Form Submission from ${name}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #8b5cf6;">New Contact Form Submission</h2>
                    <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p><strong>Name:</strong> ${name}</p>
                        <p><strong>Email:</strong> ${email}</p>
                        <p><strong>Message:</strong></p>
                        <div style="background-color: white; padding: 15px; border-radius: 4px; margin-top: 10px;">
                            ${message.replace(/\n/g, '<br>')}
                        </div>
                    </div>
                    <p style="color: #666; font-size: 12px;">
                        This email was sent from the Cell Spott Manage contact form.
                    </p>
                </div>
            `,
            text: `
New Contact Form Submission

Name: ${name}
Email: ${email}

Message:
${message}

---
This email was sent from the Cell Spott Manage contact form.
            `
        };

        // Send email
        await transporter.sendMail(mailOptions);

        res.json({ 
            success: true, 
            message: 'Thank you for your message! We\'ll get back to you soon.' 
        });

    } catch (error) {
        console.error('Error sending contact form email:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send message. Please try again later.' 
        });
    }
});

module.exports = router;

