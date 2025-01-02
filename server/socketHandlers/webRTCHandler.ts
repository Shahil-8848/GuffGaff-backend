import { Server, Socket } from 'socket.io';
import { ConnectionManager } from '../services/ConnectionManager';

export const setupWebRTCHandlers = (io: Server, socket: Socket, connectionManager: ConnectionManager) => {
  socket.on('offer', ({ peerId, offer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit('error', { message: 'Invalid peer relationship for offer' });
      return;
    }

    io.to(peerId).emit('offer', {
      offer,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('answer', ({ peerId, answer }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit('error', { message: 'Invalid peer relationship for answer' });
      return;
    }

    io.to(peerId).emit('answer', {
      answer,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('ice-candidate', ({ peerId, candidate }) => {
    const room = connectionManager.validatePeers(socket.id, peerId);
    if (!room) {
      socket.emit('error', { message: 'Invalid peer relationship for ICE candidate' });
      return;
    }

    io.to(peerId).emit('ice-candidate', {
      candidate,
      fromPeerId: socket.id,
      roomId: room.roomId,
      timestamp: new Date().toISOString(),
    });
  });
};