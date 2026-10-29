'use strict';
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mi0ir

// Offline specification simulator. No native dependencies or device access.
const { EventEmitter } = require('node:events');

class PkrgSimulator extends EventEmitter {
  constructor({ supported = true, mode = 0 } = {}) {
    super();
    this.supported = supported;
    this.mode = mode;
    this.colors = Array.from({ length: 92 }, (_, index) => [index, 255 - index, (index * 7) % 256]);
    this.requests = [];
    this.beforeRequest = null;
    this.mutateReply = null;
    this.pendingCommit = false;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  async request(bytes) {
    if (!Array.isArray(bytes) || bytes.length !== 32 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error('Simulator expected a 32-byte payload.');
    }
    const request = [...bytes];
    this.requests.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.beforeRequest) await this.beforeRequest(request, this);
      const reply = [...request];
      if (this.supported) {
        if (request[1] !== 127 || ![7, 8].includes(request[0])) {
          throw new Error('Unexpected simulator command/channel.');
        }
        const [command, , operation] = request;
        reply[3] = 0;
        if (command === 8 && operation === 0) {
          reply.splice(4, 10, 80, 75, 82, 71, 2, 92, 8, this.mode, 9, 11);
        } else if (operation === 1) {
          if (command === 7) {
            if (this.pendingCommit) reply[3] = 5;
            else if (![0, 1].includes(request[4])) reply[3] = 3;
            else this.mode = request[4];
          }
          reply[4] = this.mode;
        } else if (operation === 2) {
          const start = request[4], count = request[5];
          if (count < 1 || count > 8 || start >= 92 || start + count > 92) reply[3] = 2;
          else if (command === 7 && this.pendingCommit) reply[3] = 5;
          else {
            if (command === 7) {
              for (let index = 0; index < count; index++) this.colors[start + index] = request.slice(6 + 3 * index, 9 + 3 * index);
            }
            for (let index = 0; index < count; index++) reply.splice(6 + 3 * index, 3, ...this.colors[start + index]);
          }
        } else reply[3] = 1;
      }
      return this.mutateReply ? await this.mutateReply(request, reply, this) : reply;
    } finally {
      this.inFlight -= 1;
    }
  }
}

module.exports = { PkrgSimulator };
