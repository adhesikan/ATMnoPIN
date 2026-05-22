# ATMwithNoPIN

## Project Overview

A static web project hosted on Railway with a Firebase Firestore-backed chat and visitor logging system. The project is centered around the domain `atmwithnopin.com` and uses a dark, neon-inspired design.

## Stack

- Static HTML/CSS/JS frontend
- Firebase Firestore for chat and visitor audit logging
- Railway hosting with a Node.js static server
- Domain: `atmwithnopin.com` via Namecheap

## Files

- `index.html` — main landing page
- `chat.html` — Firebase chat room with multi-channel support
- `server.js` — Node.js static file server for Railway
- `visitor-tracker.js` — visitor geo and IP logging
- `dhezz.jpeg` — Dhezz portrait illustration

## Style

- Dark theme: `#0a0a0a`
- Green accent: `#00c853`
- Gold accent: `#c9a84c`
- Fonts: `DM Mono`, `Bebas Neue`, `DM Serif Display`

## Features

- Multi-channel chat with support for public, private, and secret rooms
- Firebase visitor audit log capturing IPv4, IPv6, and geolocation details
- Admin panel for managing chat and pinned content
- Pinned messages in chat channels
- Staff appreciation section dedicated to Foxwoods poker staff
- Social links: `@ATMwithNoPIN` on X, TikTok, and YouTube

## Firebase Configuration

- Firebase project: `atmwithnopin-c5bd7`
- Firestore collections:
  - `channels`
  - `visits`
  - `pins`

## Deployment

- Push to GitHub `main`
- Railway auto-deploys within 60 seconds
