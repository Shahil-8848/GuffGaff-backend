const express = require("express");
const { Server } = require("socket.io");
const TextChatConnectionManager = require("./ConnectionManager");

function setupTextChatServer(server) {
  const io = new Server(server, {
    path: "/text-chat",
    cors: {
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",")
        : ["http://localhost:5173"],
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket"],
  });

  const connectionManager = new TextChatConnectionManager();

  io.on("connection", async (socket) => {
    console.log(`[TextChat] New connection: ${socket.id}`);

    try {
      const userData = {
        socketId: socket.id,
        firestoreId: socket.handshake.query.firestoreId,
        userName: socket.handshake.query.userName,
        userPhoto: socket.handshake.query.userPhoto,
      };

      connectionManager.addUser(socket.id, userData);
      io.emit("stats-update", connectionManager.getStats());

      socket.on("find-match", async () => {
        console.log(`[TextChat] Find match request from: ${socket.id}`);

        const waitingPartnerId = connectionManager.getNextWaitingUser();

        if (waitingPartnerId) {
          const match = await connectionManager.createMatch(
            socket.id,
            waitingPartnerId
          );

          if (!match) {
            socket.emit("error", { message: "Failed to create match" });
            return;
          }

          // Emit match event to both users
          match.participants.forEach((participant) => {
            const otherParticipant = match.participants.find(
              (p) => p.socketId !== participant.socketId
            );

            io.to(participant.socketId).emit("match", {
              matchId: match.id,
              peerId: otherParticipant.socketId,
              peerFirestoreId: otherParticipant.firestoreId,
              peerData: otherParticipant.userData,
            });
          });
        } else {
          connectionManager.addToWaitingQueue(socket.id);
          socket.emit("waiting");
        }

        io.emit("stats-update", connectionManager.getStats());
      });

      socket.on("confirm-match", ({ matchId }) => {
        const confirmed = connectionManager.confirmMatch(matchId, socket.id);
        if (confirmed) {
          const match = connectionManager.matches.get(matchId);
          match.participants.forEach((participant) => {
            io.to(participant.socketId).emit("match-confirmed", { matchId });
          });
        }
      });

      socket.on("chat-message", (message) => {
        const user = connectionManager.users.get(socket.id);
        if (!user || !user.matchId) return;

        const match = connectionManager.matches.get(user.matchId);
        if (!match) return;

        const recipient = match.participants.find(
          (p) => p.socketId !== socket.id
        );
        if (!recipient) return;

        connectionManager.addMessage(user.matchId, message);
        io.to(recipient.socketId).emit("chat-message", message);
        socket.emit("message-delivered", message.id);
      });

      socket.on("disconnect", () => {
        console.log(`[TextChat] Disconnection: ${socket.id}`);

        const partnerId = connectionManager.breakMatch(socket.id);
        if (partnerId) {
          io.to(partnerId).emit("partner-left", {
            reason: "Partner disconnected",
            timestamp: new Date().toISOString(),
          });
        }

        connectionManager.removeUser(socket.id);
        io.emit("stats-update", connectionManager.getStats());
      });
    } catch (error) {
      console.error("[TextChat] Error in connection handler:", error);
      socket.emit("error", { message: "Internal server error" });
    }
  });

  return io;
}

module.exports = { setupTextChatServer };
