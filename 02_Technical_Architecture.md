# Technical Architecture - Legacy

## Stack Recommendation
- Frontend: React / Next.js
- Backend: Node.js (NestJS or Express)
- DB: PostgreSQL
- File Storage: S3 compatible (encrypted)
- Auth: Passkeys + OAuth + MFA
- AI: Claude API / OpenAI API

## Security Model
- End-to-end encryption (zero knowledge vault)
- Client-side encryption for sensitive fields
- Key management via user passphrase + device keys
- Role-based access control (RBAC)

## Core Services
- Auth Service
- Vault Service (encrypted data)
- Financial Service
- Document Service
- AI Orchestrator Service
- Notification Service
- Survivor Activation Engine

## Data Strategy
- Structured relational DB for metadata
- Encrypted blob storage for sensitive content
