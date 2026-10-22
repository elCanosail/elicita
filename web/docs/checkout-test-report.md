# Checkout Test Report - Elicita

Fecha: 2026-06-20

## 1. Configuracion verificada

### Variables de entorno
Archivo `.env` (desarrollo) contiene:
- STRIPE_SECRET_KEY presente (empieza por `sk_live_`)
- PUBLIC_STRIPE_PUBLISHABLE_KEY presente
- STRIPE_WEBHOOK_SECRET presente

Archivo `.env.production` **NO contiene** variables de Stripe.
> Accion requerida: anadir STRIPE_SECRET_KEY, PUBLIC_STRIPE_PUBLISHABLE_KEY y STRIPE_WEBHOOK_SECRET a .env.production antes del deploy.

### Webhook registrado en Stripe
- URL: https://elicita.es/api/stripe/webhook
- Estado: enabled
- Eventos: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_succeeded, invoice.payment_failed

### Price ID verificado
- price_1T9CX7RlVvV3kbDFCmbDYudo (Pro mensual)
- Monto: 14900 centimos / EUR
- Estado: active

## 2. Scripts de test

### scripts/test-checkout.sh
- Llamada POST a /api/test/checkout-flow con plan=pro e interval=month.
- Imprime la URL de Stripe Checkout.

### scripts/test-webhook.sh
- Envio de payload checkout.session.completed sin firma.
- Esperado: HTTP 400 (rechazo de firma invalida).
- stripe-cli instalado (v1.42.14), pero requiere `stripe login` (OAuth) para eventos reales.

### src/pages/api/test/checkout-flow.ts
- Endpoint temporal bloqueado en produccion (NODE_ENV === production -> 403).
- Crea una Checkout Session de Stripe para Pro mensual.

## 3. Resultados

- Checkout Session creada correctamente via Stripe SDK.
- URL de checkout generada.
- Endpoint webhook rechaza payloads sin firma valida (HTTP 400).
- Pagina /cuenta/plan?success=true renderiza banner de exito.
- Pagina /cuenta/plan sin success muestra los planes.

## 4. Problemas encontrados

1. .env.production sin variables Stripe.
2. Claves live (sk_live_): no se pueden usar tarjetas de test automaticamente.
3. No se verifico actualizacion de Clerk metadata por falta de evento firmado real (falta stripe login).
4. Endpoint temporal debe eliminarse o protegerse antes de produccion.

## 5. Pasos manuales pendientes

1. Migrar a claves de test (`sk_test_` / `pk_test_`) en .env para desarrollo.
2. Anadir variables Stripe a .env.production.
3. Ejecutar en local:
   - `stripe login`
   - `stripe listen --forward-to http://localhost:4321/api/stripe/webhook`
   - `./scripts/test-checkout.sh`
   - Completar pago con tarjeta test 4242 4242 4242 4242.
   - Verificar log `[Stripe] checkout.session.completed` y metadata de Clerk.

## Archivos creados

- scripts/test-checkout.sh
- scripts/test-webhook.sh
- src/pages/api/test/checkout-flow.ts
- docs/checkout-test-report.md
