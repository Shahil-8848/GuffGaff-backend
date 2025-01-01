const logEvent = require("./logger");
function setupSocketHandlers(io, connectionManager) {
  io.on("connection", (socket) => {
    logEvent("connection", socket.id);

    connectionManager.addUser(socket.id);
    io.emit("stats-update", connectionManager.getConnectionStats());
    socket.on("find-match", () => {
      logEvent("find-match", socket.id);
      const waitingPartnerId = connectionManager.getNextWaitingUser();

      if (waitingPartnerId) {
        const roomId = connectionManager.createPartnership(
          socket.id,
          waitingPartnerId
        );
        const matchData = {
          timestamp: new Date().toISOString(),
          roomId,
          matchId: `${socket.id.slice(0, 4)}-${waitingPartnerId.slice(0, 4)}`,
        };
        socket.emit("match", {
          ...matchData,
          peerId: waitingPartnerId,
          isInitiator: false,
        });
        io.to(waitingPartnerId).emit("match", {
          ...matchData,
          peerId: socket.id,
          isInitiator: true,
        });
        logEvent("match-created", socket.id, {
          partnerId: waitingPartnerId,
          roomId,
          matchData,
        });
      } else {
        connectionManager.addToWaitingQueue(socket.id);
        socket.emit("waiting", {
          position: connectionManager.waitingQueue.length,
          timestamp: new Date().toISOString(),
        });
      }
      io.emit("stats-update", connectionManager.getConnectionStats());
    });
    socket.on("offer", ({ peerId, offer, fromPeerId }) => {
      logEvent("offer", socket.id, { toPeer: peerId, fromPeer: fromPeerId });

      const room = connectionManager.validatePeers(fromPeerId, peerId);
      if (!room) {
        socket.emit("signaling-error", {
          type: "offer",
          message: "Invalid peer relationship",
          timestamp: new Date().toISOString(),
        });
        return;
      }
      connectionManager.updateRoomState(room.roomId, "offer-sent", fromPeerId);
      io.to(peerId).emit("offer", {
        offer,
        fromPeerId,
        roomId: room.roomId,
        timestamp: new Date().toISOString(),
      });
    });
    socket.on("answer", ({ peerId, answer, fromPeerId }) => {
      logEvent("answer", socket.id, { toPeer: peerId, fromPeer: fromPeerId });

      const room = connectionManager.validatePeers(fromPeerId, peerId);
      if (!room) {
        socket.emit("signaling-error", {
          type: "answer",
          message: "Invalid peer relationship",
          timestamp: new Date().toISOString(),
        });
        return;
      }
      connectionManager.updateRoomState(room.roomId, "answer-sent", fromPeerId);
      io.to(peerId).emit("answer", {
        answer,
        fromPeerId,
        roomId: room.roomId,
        timestamp: new Date().toISOString(),
      });
    });
    socket.on("ice-candidate", ({ peerId, candidate, fromPeerId }) => {
      logEvent("ice-candidate", socket.id, {
        toPeer: peerId,
        fromPeer: fromPeerId,
      });

      const room = connectionManager.validatePeers(fromPeerId, peerId);
      if (!room) {
        socket.emit("signaling-error", {
          type: "ice-candidate",
          message: "Invalid peer relationship",
          timestamp: new Date().toISOString(),
        });
        return;
      }
      io.to(peerId).emit("ice-candidate", {
        candidate,
        fromPeerId,
        roomId: room.roomId,
        timestamp: new Date().toISOString(),
      });
    });
    socket.on("disconnect", (reason) => {
      logEvent("disconnect", socket.id, { reason });

      const partnerId = connectionManager.breakPartnership(socket.id);
      if (partnerId) {
        io.to(partnerId).emit("partner-left", {
          reason: "Partner disconnected",
          timestamp: new Date().toISOString(),
        });
      }
      connectionManager.removeUser(socket.id);
      io.emit("stats-update", connectionManager.getConnectionStats());
    });
  });
}
module.exports = setupSocketHandlers;
