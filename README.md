# eisberg

a webapp and app that allows you to create, share, and deploy no-code apps. targetted for non-vibcoders, non-coders, and non-technical users. framer is a gold standard for us right now—though we're not yet implementing all of its features, like drag-and-drop and templates.

impetus:
- existing apps aren't beautiful enough, too complicated
- want to have apps that are generated like emergent.sh (doesn't do native apps yet)

competitor: [lots]

our first prototype:
- chat/prompt to create the apps through a web app using claude opus
- use a component library like shadcn/ui
- updates immediately deploy to the native app
- expo app to build and deploy the apps

## Local web builder

- `cd web && npm run dev` to start the Next.js + shadcn/ui web app (chat + preview)
- prompt on the web, then deploy streams schema updates to the iOS simulator

## Native preview app

- `cd mobile && npm run ios` to launch the Expo iOS dev client.
- It subscribes to `http://localhost:3000/api/stream?projectId=project-alpha` by default. Set `EXPO_PUBLIC_WEB_BASE_URL` if running the web server elsewhere or on-device (e.g., `http://<your-ip>:3000`).
- Use the web “Deploy to simulator” button to push the latest blueprint; the app validates, caches last-known-good (AsyncStorage), and renders it. Use “Freeze updates” in-app to pause bad payloads.
- just ios for now

## Debugging

### Mobile

- If Google OAuth sends you to `https://www.eisberg.ai` instead of back to the app, Supabase rejected the redirect URL and fell back to the Site URL.
- Add the exact redirect URL the device is using in Supabase Auth settings.
- Expo Go (proxy): `https://auth.expo.io/@eisberg/mobile` (stable).
- Expo Go (direct): `exp://<your-ip>:8081/--/auth-callback` (IP changes often, update when your LAN IP changes).
- Standalone builds: `eisberg://auth-callback`.
- Supabase path: Project → Authentication → URL Configuration (Redirect URLs).

## Sandbox HTML deploys

- You can ship a full HTML/JS sandbox instead of the schema: `POST /api/deploy` with `sandboxHtml` (string) and optional `sandboxBaseUrl`. If no blueprint is provided, a stub blueprint is auto-filled for compatibility.
- The mobile app streams the sandbox payload over the same `/api/stream` channel and renders it in a WebView. A toggle in the top-left switches between Sandbox and Schema previews when both are present.

app features:
- haptic feedback
- light/dark mode
- database support
- business logic
- data visualizations/charts

potential approaches:
- schema of core primatives (e.g., buttons, stacks) and design features (e.g., transitions)
- allow the LLM to ship code
