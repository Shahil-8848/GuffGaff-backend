class ConnectionManager {
  constructor(io, matchMaker, roomManager) {
    this.io = io;
    this.matchMaker = matchMaker;
    this.roomManager = roomManager;
    this.users = new Map();
    this.connectionTimeouts = new Map();
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = 30000;
  }
  handleNewConnection(socket) {
    console.log(`[${new Date().toISOString()}] New connection: ${socket.id}`);

    this.addUser(socket.id);
    this.setupSocketListeners(socket);
    this.broadcastStats();
  }
  addUser(socketId) {
    this.users.set(socketId, {
      inCall: false,
      room: null,
      connectedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      connectionAttempts: 0,
    });
  }
  setupSocketListeners(socket) {
    socket.on("find-match", () => this.handleFindMatch(socket));
    socket.on("offer", (data) => this.handleOffer(socket, data));
    socket.on("answer", (data) => this.handleAnswer(socket, data));
    socket.on("ice-candidate", (data) => this.handleIceCandidate(socket, data));
    socket.on("disconnect", () => this.handleDisconnect(socket));
  }
  handleFindMatch(socket) {
    console.log(
      `[${new Date().toISOString()}] Find match request from: ${socket.id}`
    );
    const matchedUserId = this.matchMaker.findMatch(socket.id);
    if (matchedUserId) {
      const roomId = this.roomManager.createRoom([socket.id, matchedUserId]);

      const matchData = {
        timestamp: new Date().toISOString(),
        roomId,
        matchId: `${socket.id.slice(0, 4)}-${matchedUserId.slice(0, 4)}`,
      };
      // Update user states
      this.users.get(socket.id).inCall = true;
      this.users.get(matchedUserId).inCall = true;
      // Emit match events
      socket.emit("match", {
        ...matchData,
        peerId: matchedUserId,
        isInitiator: true,
      });
      this.io.to(matchedUserId).emit("match", {
        ...matchData,
        peerId: socket.id,
        isInitiator: false,
      });
      // Set connection timeout
      this.setConnectionTimeout(roomId, socket.id, matchedUserId);
    } else {
      socket.emit("waiting");
    }
    this.broadcastStats();
  }
  handleOffer(socket, { peerId, offer }) {
    const roomId = this.roomManager.getRoomByParticipant(socket.id);
    if (!this.validatePeerConnection(socket.id, peerId, roomId)) {
      return;
    }
    this.io.to(peerId).emit("offer", {
      offer,
      fromPeerId: socket.id,
      roomId,
      timestamp: new Date().toISOString(),
    });
  }
  handleAnswer(socket, { peerId, answer }) {
    const roomId = this.roomManager.getRoomByParticipant(socket.id);
    if (!this.validatePeerConnection(socket.id, peerId, roomId)) {
      return;
    }
    this.io.to(peerId).emit("answer", {
      answer,
      fromPeerId: socket.id,
      roomId,
      timestamp: new Date().toISOString(),
    });
    // Mark room as connected after answer is received
    this.roomManager.updateRoomStatus(roomId, true);
  }
  handleIceCandidate(socket, { peerId, candidate }) {
    const roomId = this.roomManager.getRoomByParticipant(socket.id);
    if (!this.validatePeerConnection(socket.id, peerId, roomId)) {
      return;
    }
    this.io.to(peerId).emit("ice-candidate", {
      candidate,
      fromPeerId: socket.id,
      roomId,
      timestamp: new Date().toISOString(),
    });
  }
  handleDisconnect(socket) {
    console.log(`[${new Date().toISOString()}] Disconnection: ${socket.id}`);

    const roomId = this.roomManager.getRoomByParticipant(socket.id);
    if (roomId) {
      const room = this.roomManager.getRoom(roomId);
      const partnerId = room.participants.find((id) => id !== socket.id);

      if (partnerId) {
        this.io.to(partnerId).emit("partner-left", {
          reason: "Partner disconnected",
          timestamp: new Date().toISOString(),
        });
      }
      this.roomManager.removeRoom(roomId);
    }
    this.users.delete(socket.id);
    this.matchMaker.removeFromWaitingQueue(socket.id);
    this.broadcastStats();
  }
  validatePeerConnection(fromId, toId, roomId) {
    if (!roomId) {
      this.io.to(fromId).emit("error", {
        message: "Invalid peer relationship",
        timestamp: new Date().toISOString(),
      });
      return false;
    }
    const room = this.roomManager.getRoom(roomId);
    return (
      room &&
      room.participants.includes(fromId) &&
      room.participants.includes(toId)
    );
  }
  setConnectionTimeout(roomId, user1Id, user2Id) {
    const timeoutId = setTimeout(() => {
      const room = this.roomManager.getRoom(roomId);
      if (room && !room.connected) {
        this.handleFailedConnection(roomId, user1Id, user2Id);
      }
    }, this.connectionTimeout);
    this.connectionTimeouts.set(roomId, timeoutId);
  }
  handleFailedConnection(roomId, user1Id, user2Id) {
    this.matchMaker.blockPair(user1Id, user2Id);

    [user1Id, user2Id].forEach((userId) => {
      const user = this.users.get(userId);
      if (user) {
        user.inCall = false;
        user.connectionAttempts++;

        this.io.to(userId).emit("connection-failed", {
          message: "Connection timed out",
          timestamp: new Date().toISOString(),
        });
      }
    });
    this.roomManager.removeRoom(roomId);
    this.connectionTimeouts.delete(roomId);
  }
  broadcastStats() {
    const stats = {
      totalUsers: this.users.size,
      ...this.matchMaker.getWaitingQueueStats(),
      activeRooms: this.roomManager.getActiveRooms().length,
    };
    this.io.emit("stats-update", stats);
  }
}
module.exports = ConnectionManager;
