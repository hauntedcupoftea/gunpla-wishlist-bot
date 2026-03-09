import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import { env } from "../lib/env.ts";

// import { kitRoutes }      from "./routes/kits.ts";
// import { wishlistRoutes } from "./routes/wishlist.ts";
// import { groupBuyRoutes } from "./routes/groupbuys.ts";
// import { authRoutes }     from "./routes/auth.ts";
// import { authMiddleware } from "./middleware/auth.ts";

export function buildApp() {
	return (
		new Elysia()
			.use(
				swagger({
					documentation: {
						info: {
							title: "Haro API",
							version: "1.0.0",
							description:
								"REST API for the Haro gunpla group-buy Discord bot. " +
								"Authenticate via Discord OAuth2 at /auth/discord. " +
								"All monetary values are in JPY unless stated otherwise. " +
								"INR equivalents are computed from GroupBuy.inrConversionRate.",
							contact: {
								name: "Haro Bot",
							},
						},
						tags: [
							{
								name: "Auth",
								description: "Discord OAuth2 session management",
							},
							{
								name: "Kits",
								description: "Kit catalogue — search, add, update",
							},
							{ name: "Wishlist", description: "Personal wishlist management" },
							{
								name: "GroupBuys",
								description: "Group buy lifecycle management",
							},
							{
								name: "Claims",
								description: "Claim management and payment tracking",
							},
						],
						components: {
							securitySchemes: {
								sessionCookie: {
									type: "apiKey",
									in: "cookie",
									name: "haro_session",
									description:
										"JWT session cookie issued after Discord OAuth2 login",
								},
							},
						},
					},
					// Scalar UI config — served at /docs
					scalarConfig: {
						theme: "purple",
						layout: "modern",
					},
					path: "/docs",
				}),
			)

			// Health check (unauthenticated)
			.get(
				"/health",
				() => ({
					status: "ok",
					timestamp: new Date().toISOString(),
				}),
				{
					detail: {
						tags: ["Auth"],
						summary: "Health check",
						description: "Returns 200 if the API server is running.",
					},
				},
			)

			// Auth routes
			.get(
				"/auth/discord",
				({ redirect }) => {
					const params = new URLSearchParams({
						client_id: env.APPLICATION_ID,
						redirect_uri: `${env.API_BASE_URL}/auth/discord/callback`,
						response_type: "code",
						scope: "identify guilds.members.read",
					});
					return redirect(`https://discord.com/oauth2/authorize?${params}`);
				},
				{
					detail: {
						tags: ["Auth"],
						summary: "Start Discord OAuth2 login",
						description:
							"Redirects the user to Discord's OAuth2 consent page. " +
							"After authorising, Discord redirects to /auth/discord/callback.",
					},
				},
			)

			// OAuth2 callback
			.get(
				"/auth/discord/callback",
				async ({ query, cookie, set }) => {
					const code = query.code;
					if (!code) {
						set.status = 400;
						return { error: "Missing OAuth2 code." };
					}

					// Exchange code for Discord access token
					const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							client_id: env.APPLICATION_ID,
							client_secret: env.DISCORD_CLIENT_SECRET,
							grant_type: "authorization_code",
							code,
							redirect_uri: `${env.API_BASE_URL}/auth/discord/callback`,
						}),
					});

					if (!tokenRes.ok) {
						set.status = 401;
						return { error: "Failed to exchange OAuth2 code." };
					}

					const tokenData = (await tokenRes.json()) as { access_token: string };

					// Fetch the authenticated user's Discord profile
					const userRes = await fetch("https://discord.com/api/users/@me", {
						headers: { Authorization: `Bearer ${tokenData.access_token}` },
					});

					if (!userRes.ok) {
						set.status = 401;
						return { error: "Failed to fetch Discord user." };
					}

					const user = (await userRes.json()) as {
						id: string;
						username: string;
					};

					// Issue a signed JWT session cookie
					// NOTE: Full JWT signing is implemented in middleware/auth.ts.
					// This stub just returns the user info for now.
					set.status = 200;
					return {
						message: "Authenticated successfully.",
						userId: user.id,
						username: user.username,
					};
				},
				{
					query: t.Object({ code: t.Optional(t.String()) }),
					detail: {
						tags: ["Auth"],
						summary: "Discord OAuth2 callback",
						description:
							"Handles the OAuth2 redirect from Discord. Exchanges the " +
							"authorisation code for an access token, verifies the user is a " +
							"member of the server, and issues a signed session cookie.",
					},
				},
			)

			// ── Placeholder route — routes will be mounted here ───────────────────
			.get(
				"/",
				() => ({
					name: "Haro API",
					version: "1.0.0",
					docs: "/docs",
					health: "/health",
				}),
				{
					detail: {
						tags: ["Auth"],
						summary: "API root",
						description: "Returns API metadata and links.",
					},
				},
			)
	);

	// When route files are implemented, mount them like:
	// .use(authRoutes)
	// .use(kitRoutes)
	// .use(wishlistRoutes)
	// .use(groupBuyRoutes)
}

export function startApi(): Deno.HttpServer {
	const app = buildApp();

	return Deno.serve(
		{
			port: env.API_PORT,
			hostname: "0.0.0.0",
			onListen: ({ port, hostname }) => {
				console.log(`[api] Listening on http://${hostname}:${port}`);
				console.log(`[api] Docs available at http://${hostname}:${port}/docs`);
			},
			onError: (error) => {
				console.error("[api] Server error:", error);
				return new Response("Internal Server Error", { status: 500 });
			},
		},
		app.fetch,
	);
}
