import { DurableObject } from "cloudflare:workers";

const ALLOWED_MESSAGES = new Set([
  "ready",
  "start",
  "state",
  "action",
  "input",
  "ball",
  "hp",
  "combo",
  "finish",
  "chat"
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type"
    }
  });
}

function makeRoomCode() {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Content-Type"
        }
      });
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(
        "闪身步大乱斗联机服务器 ONLINE",
        {
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        }
      );
    }

    // 创建房间
    if (
      request.method === "POST" &&
      url.pathname === "/api/create"
    ) {
      let body = {};

      try {
        body = await request.json();
      } catch {}

      const mode = body.mode === "2v2" ? "2v2" : "1v1";
      const maxPlayers = mode === "2v2" ? 4 : 2;

      let code;

      for (let i = 0; i < 20; i++) {
        const candidate = makeRoomCode();
        const id = env.ROOMS.idFromName(candidate);
        const room = env.ROOMS.get(id);

        const response = await room.fetch(
          new Request("https://internal/room-info")
        );

        if (response.status === 404) {
          code = candidate;
          break;
        }
      }

      if (!code) {
        return json({
          success: false,
          error: "无法生成房间，请稍后再试"
        }, 500);
      }

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      await room.fetch(
        new Request("https://internal/create", {
          method: "POST",
          body: JSON.stringify({
            mode,
            maxPlayers
          })
        })
      );

      return json({
        success: true,
        roomCode: code,
        mode,
        maxPlayers
      });
    }

    // 查询房间
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/room/")
    ) {
      const code = url.pathname
        .split("/")
        .pop()
        .toUpperCase();

      if (!/^[0-9A-Z]{6}$/.test(code)) {
        return json({
          success: false,
          error: "房间密码格式错误"
        }, 400);
      }

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch(
        new Request("https://internal/room-info")
      );
    }

    // WebSocket
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/room/")
    ) {
      const upgrade = request.headers.get("Upgrade");

      if (upgrade !== "websocket") {
        return new Response(
          "WebSocket endpoint",
          { status: 426 }
        );
      }

      const code = url.pathname
        .split("/")
        .pop()
        .toUpperCase();

      if (!/^[0-9A-Z]{6}$/.test(code)) {
        return new Response("Invalid room code", {
          status: 400
        });
      }

      const id = env.ROOMS.idFromName(code);
      const room = env.ROOMS.get(id);

      return room.fetch(request);
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};


export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.players = new Map();

    this.mode = "1v1";
    this.maxPlayers = 2;
    this.created = false;

    this.loadPromise = this.loadRoom();
  }

  async loadRoom() {
    const data = await this.ctx.storage.get("room");

    if (data) {
      this.mode = data.mode || "1v1";
      this.maxPlayers = data.maxPlayers || 2;
      this.created = true;
    }
  }

  async saveRoom() {
    await this.ctx.storage.put("room", {
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      created: true
    });
  }

  async fetch(request) {
    await this.loadPromise;

    const url = new URL(request.url);

    // 创建房间
    if (
      request.method === "POST" &&
      url.pathname === "/create"
    ) {
      let body = {};

      try {
        body = await request.json();
      } catch {}

      this.mode = body.mode === "2v2"
        ? "2v2"
        : "1v1";

      this.maxPlayers =
        this.mode === "2v2" ? 4 : 2;

      this.created = true;

      await this.saveRoom();

      return json({
        success: true,
        mode: this.mode,
        maxPlayers: this.maxPlayers,
        players: this.players.size
      });
    }

    // 房间资料
    if (url.pathname === "/room-info") {
      if (!this.created) {
        return new Response("ROOM_NOT_FOUND", {
          status: 404
        });
      }

      return json({
        success: true,
        mode: this.mode,
        maxPlayers: this.maxPlayers,
        players: this.players.size
      });
    }

    // WebSocket
    if (
      request.headers.get("Upgrade") === "websocket"
    ) {
      return this.handleWebSocket(request);
    }

    return new Response("Not Found", {
      status: 404
    });
  }

  handleWebSocket(request) {
    if (!this.created) {
      return new Response("Room does not exist", {
        status: 404
      });
    }

    if (this.players.size >= this.maxPlayers) {
      return new Response("ROOM_FULL", {
        status: 409
      });
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    const playerId = crypto.randomUUID();

    let team = "A";

    if (this.mode === "2v2") {
      const teamACount =
        [...this.players.values()]
          .filter(p => p.team === "A").length;

      const teamBCount =
        [...this.players.values()]
          .filter(p => p.team === "B").length;

      team = teamACount <= teamBCount
        ? "A"
        : "B";
    }

    this.players.set(playerId, {
      id: playerId,
      team,
      ws: server
    });

    server.accept();

    server.send(JSON.stringify({
      type: "welcome",
      playerId,
      team,
      mode: this.mode,
      maxPlayers: this.maxPlayers
    }));

    this.broadcast({
      type: "room_update",
      players: this.getPlayerList()
    }, playerId);

    server.addEventListener("message", async event => {
      try {
        const message = JSON.parse(event.data);

        if (!message || !ALLOWED_MESSAGES.has(message.type)) {
          return;
        }

        this.broadcast({
          ...message,
          from: playerId
        }, playerId);

      } catch {
        // 忽略非法消息
      }
    });

    server.addEventListener("close", () => {
      this.players.delete(playerId);

      this.broadcast({
        type: "player_left",
        playerId,
        players: this.getPlayerList()
      });
    });

    server.addEventListener("error", () => {
      this.players.delete(playerId);

      this.broadcast({
        type: "player_left",
        playerId,
        players: this.getPlayerList()
      });
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  getPlayerList() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      team: p.team
    }));
  }

  broadcast(message, exceptPlayerId = null) {
    const data = JSON.stringify(message);

    for (const [id, player] of this.players) {
      if (id === exceptPlayerId) continue;

      try {
        player.ws.send(data);
      } catch {
        this.players.delete(id);
      }
    }
  }
          }
