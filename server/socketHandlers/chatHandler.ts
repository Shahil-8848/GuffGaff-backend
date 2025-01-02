import { Server, Socket } from 'socket.io';
import { ConnectionManager } from '../ConnectionManager';

export const setupChatHandlers = (io: Server, socket: Socket, connectionManager: ConnectionManager) => {
  socket.on('chat-message', (message) => {
    const roomId = connectionManager.getRoomByParticipant(socket.id);
    if (roomId) {
      const room = connectionManager.getRoomByParticipant(socket.id);
      if (room) {
        // Broadcast message to all users in the room except sender
        socket.to(room).emit('chat-message', {
          ...message,
          timestamp: new Date().toISOString(),
          fromId: socket.id
        });
      }
    }
  });
};