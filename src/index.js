
import { DurableObject } from "cloudflare:workers";

const ROOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*"
    }
  });
}

function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    // 健康检查
    if (url.pathname === "/" && request.method === "GET") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("闪身步大乱斗联机服务器 ONLINE", {
          headers: {
            "content-type": "text/plain; charset=UTF-8"
          }
        });
      }
    }

    // 所有玩家先连接同一个 WebSocket 根地址
    if (
      request.method === "GET" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const id = env.ROOMS.idFromName("GLOBAL_GAME_SERVER");
      const roomServer = env.ROOMS.get(id);
      return roomServer.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.rooms = {};
    this.sockets = new Map();

    this.loadPromise = this.loadRooms();
  }

  async loadRooms() {
    const saved = await this.ctx.storage.get("rooms");
    if (saved && typeof saved === "object") {
      this.rooms = saved;
    }
  }

  async saveRooms() {
    const data = {};

    for (const [code, room] of Object.entries(this.rooms)) {
      data[code] = {
        code: room.code,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        host: room.host,
        state: room.state,
        players: room.players.map(p => {
          if (!p) return null;

          return {
            slot: p.slot,
            team: p.team,
            name: p.name,
            token: p.token,
            ready: p.ready,
            connected: p.connected,
            hp: p.hp
          };
        })
      };
    }

    await this.ctx.storage.put("rooms", data);
  }

  send(ws, message) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
      }
    } catch (e) {
      // 忽略发送失败
    }
  }

  broadcast(room, message, except = null) {
    for (const player of room.players) {
      if (!player || !player.connected || !player.socket) continue;
      if (player.socket === except) continue;

      this.send(player.socket, message);
    }
  }

  getPlayerList(room) {
    return room.players.map(p => {
      if (!p) return null;

      return {
        slot: p.slot,
        team: p.team,
        name: p.name,
        ready: !!p.ready,
        connected: !!p.connected
      };
    });
  }

  sendRoom(room) {
    this.broadcast(room, {
      t: "room",
      code: room.code,
      mode: room.mode,
      host: room.host,
      players: this.getPlayerList(room),
      state: room.state
    });
  }

  sendError(ws, message) {
    this.send(ws, {
      t: "err",
      msg: message
    });
  }

  async fetch(request) {
    await this.loadPromise;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket Required", {
        status: 426
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", event => {
      this.handleMessage(server, event.data).catch(() => {
        this.sendError(server, "服务器处理消息时发生错误。");
      });
    });

    server.addEventListener("close", () => {
      this.handleDisconnect(server);
    });

    server.addEventListener("error", () => {
      this.handleDisconnect(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async handleMessage(ws, raw) {
    let message;

    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (!message || typeof message.t !== "string") {
      return;
    }

    switch (message.t) {
      case "create":
        await this.createRoom(ws, message);
        break;

      case "join":
        await this.joinRoom(ws, message);
        break;

      case "rejoin":
        await this.rejoinRoom(ws, message);
        break;

      case "ready":
        await this.setReady(ws, message);
        break;

      case "start":
        await this.startGame(ws);
        break;

      case "abort":
        await this.abortGame(ws);
        break;

      case "leave":
        await this.leaveRoom(ws);
        break;

      case "snap":
        this.relay(ws, "snap", {
          s: message.s
        });
        break;

      case "ev":
        this.relay(ws, "ev", {
          ev: message.ev
        });
        break;

      case "ko":
        await this.playerKO(ws);
        break;

      default:
        break;
    }
  }

  findPlayer(ws) {
    const info = this.sockets.get(ws);
    if (!info) return null;

    const room = this.rooms[info.code];
    if (!room) return null;

    const player = room.players[info.slot];
    if (!player || player.socket !== ws) return null;

    return { room, player, info };
  }

  async createRoom(ws, message) {
    let code;

    for (let i = 0; i < 30; i++) {
      const candidate = makeCode();

      if (!this.rooms[candidate]) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      this.sendError(ws, "暂时无法创建房间，请再试一次。");
      return;
    }

    const mode = message.mode === "2v2" ? "2v2" : "1v1";
    const maxPlayers = mode === "2v2" ? 4 : 2;

    const room = {
      code,
      mode,
      maxPlayers,
      host: 0,
      state: "lobby",
      players: Array(maxPlayers).fill(null)
    };

    const player = {
      slot: 0,
      team: 0,
      name: String(message.name || "玩家").slice(0, 10),
      token: crypto.randomUUID(),
      ready: true,
      connected: true,
      hp: 100,
      socket: ws
    };

    room.players[0] = player;
    this.rooms[code] = room;

    this.sockets.set(ws, {
      code,
      slot: 0,
      token: player.token
    });

    await this.saveRooms();

    this.send(ws, {
      t: "created",
      code,
      slot: 0,
      token: player.token,
      mode
    });

    this.sendRoom(room);
  }

  async joinRoom(ws, message) {
    const code = String(message.code || "").trim().toUpperCase();

    if (!/^[0-9A-Z]{6}$/.test(code)) {
      this.sendError(ws, "房间密码格式错误。");
      return;
    }

    const room = this.rooms[code];

    if (!room) {
      this.sendError(ws, "找不到这个房间，请检查密码。");
      return;
    }

    if (room.state !== "lobby") {
      this.sendError(ws, "这场游戏已经开始，暂时不能加入。");
      return;
    }

    const slot = room.players.findIndex(p => p === null);

    if (slot === -1) {
      this.sendError(ws, "房间人数已满。");
      return;
    }

    const player = {
      slot,
      team: room.mode === "2v2" ? (slot < 2 ? 0 : 1) : slot,
      name: String(message.name || "玩家").slice(0, 10),
      token: crypto.randomUUID(),
      ready: false,
      connected: true,
      hp: 100,
      socket: ws
    };

    room.players[slot] = player;

    this.sockets.set(ws, {
      code,
      slot,
      token: player.token
    });

    await this.saveRooms();

    this.send(ws, {
      t: "joined",
      code,
      slot,
      token: player.token,
      mode: room.mode
    });

    this.sendRoom(room);
  }

  async rejoinRoom(ws, message) {
    const code = String(message.code || "").toUpperCase();
    const room = this.rooms[code];

    if (!room) {
      this.sendError(ws, "房间已不存在，无法重新连接。");
      return;
    }

    const player = room.players.find(
      p => p && p.token === message.token
    );

    if (!player) {
      this.sendError(ws, "重新连接验证失败。");
      return;
    }

    if (player.socket && player.socket !== ws) {
      try {
        player.socket.close();
      } catch (e) {}
    }

    player.socket = ws;
    player.connected = true;

    this.sockets.set(ws, {
      code,
      slot: player.slot,
      token: player.token
    });

    await this.saveRooms();

    this.send(ws, {
      t: "resume",
      mode: room.mode,
      players: this.getPlayerList(room)
    });

    this.broadcast(room, {
      t: "peer",
      status: "back",
      slot: player.slot
    }, ws);

    this.sendRoom(room);
  }

  async setReady(ws, message) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    if (room.state !== "lobby" || player.slot === room.host) {
      return;
    }

    player.ready = !!message.v;

    await this.saveRooms();
    this.sendRoom(room);
  }

  async startGame(ws) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    if (player.slot !== room.host) {
      this.sendError(ws, "只有房主可以开始游戏。");
      return;
    }

    const connectedPlayers = room.players.filter(
      p => p && p.connected
    );

    if (connectedPlayers.length < 2) {
      this.sendError(ws, "至少需要两名玩家才能开始。");
      return;
    }

    room.state = "game";

    for (const p of room.players) {
      if (p) p.hp = 100;
    }

    await this.saveRooms();

    const players = room.players
      .filter(p => p && p.connected)
      .map(p => ({
        slot: p.slot,
        team: p.team,
        name: p.name
      }));

    this.broadcast(room, {
      t: "start",
      mode: room.mode,
      players
    });
  }

  async abortGame(ws) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    if (player.slot !== room.host) {
      this.sendError(ws, "只有房主可以结束本局。");
      return;
    }

    room.state = "lobby";

    for (const p of room.players) {
      if (p) p.ready = false;
    }

    await this.saveRooms();
    this.sendRoom(room);
  }

  relay(ws, type, payload) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    if (room.state !== "game") return;

    this.broadcast(room, {
      t: type,
      slot: player.slot,
      ...payload
    }, ws);
  }

  async playerKO(ws) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    if (room.state !== "game") return;

    player.hp = 0;

    const losingTeam = player.team;

    const teammatesAlive = room.players.some(p =>
      p &&
      p.team === losingTeam &&
      p.hp > 0
    );

    if (!teammatesAlive) {
      const winningTeam = losingTeam === 0 ? 1 : 0;

      room.state = "lobby";

      this.broadcast(room, {
        t: "over",
        winTeam: winningTeam
      });

      await this.saveRooms();
    }
  }

  async leaveRoom(ws) {
    const found = this.findPlayer(ws);
    if (!found) return;

    const { room, player } = found;

    room.players[player.slot] = null;
    this.sockets.delete(ws);

    if (room.host === player.slot) {
      const nextHost = room.players.find(p => p && p.connected);
      room.host = nextHost ? nextHost.slot : 0;
    }

    const remaining = room.players.filter(Boolean);

    if (remaining.length === 0) {
      delete this.rooms[room.code];
      await this.saveRooms();
      return;
    }

    this.broadcast(room, {
      t: "peer",
      status: "left",
      slot: player.slot
    });

    await this.saveRooms();
    this.sendRoom(room);
  }

  async handleDisconnect(ws) {
    const found = this.findPlayer(ws);
    this.sockets.delete(ws);

    if (!found) return;

    const { room, player } = found;

    player.connected = false;
    player.socket = null;

    this.broadcast(room, {
      t: "peer",
      status: "disconnected",
      slot: player.slot
    });

    await this.saveRooms();
    this.sendRoom(room);
  }
}
