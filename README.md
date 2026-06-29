# ATMNOPIN Blog + Admin

## What is included
- Public blog listing at /blog
- Individual post pages at /blog/[slug]
- Protected admin area at /admin
- Draft/publish support, featured image, gallery images, YouTube/Vimeo links, tags, and simple SEO metadata
- Optional Cloudinary uploads for persistent image storage; local uploads are used when Cloudinary is not configured

## Admin login
1. Set `ADMIN_EMAIL` and either `ADMIN_PASSWORD_HASH` or `ADMIN_PASSWORD` in your environment.
2. Start the server with `node server.js`.
3. Open `/admin` and sign in.

## Create a post
1. Sign in at `/admin`.
2. Fill in title, excerpt, body, tags, status, and video links.
3. Upload a featured image and gallery images if desired.
4. Save as draft or publish.

## Media uploads
- Local uploads are stored in `uploads/`.
- If `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET` are provided, image uploads go to Cloudinary instead.
- Only safe image types are accepted: jpg, jpeg, png, webp.

## Environment variables
See `.env.example` for the required variables.

## Deployment notes
- The local upload path is fine for development.
- For persistent production hosting, configure Cloudinary upload preset and set the Cloudinary variables in your deployment environment.
