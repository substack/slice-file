var fs = require('fs');
var through = require('through2');
var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var split = require('split2');

var nextTick = typeof setImmediate === 'function'
    ? setImmediate
    : process.nextTick
;

module.exports = function (file, opts) {
    if (!opts) opts = {};
    if (opts.flags === undefined) opts.flags = 'r';
    if (opts.mode === undefined) opts.mode = 0666;

    var fa = new FA(file, opts);

    if (opts.fd === undefined) {
        fs.open(file, opts.flags, opts.mode, function (err, fd) {
            if (err) return fa.emit('error', err)
            fa.fd = fd;
            fa.emit('open', fd)
            for (var i = 0; i < fa._onopen.length; i++) fa._onopen[i]();
            fa._onopen.splice(0);
        });
    }
    return fa;
};

function FA (file, opts) {
    this.file = file;
    this.offsets = { 0: 0 };
    this.bufsize = opts.bufsize || 4 * 1024;
    this.flags = opts.flags;
    this.mode = opts.mode;
    this._onopen = [];
}

inherits(FA, EventEmitter);

FA.prototype._read = onopen(function (start, end, cb, rev) {
    var self = this;
    if (start === undefined) start = 0;
    if (start < 0) return self._readReverse(start, end, cb, rev);

    if (end !== undefined && end <= start) {
        return nextTick(function () { cb(null, null) });
    }

    var found = false;
    var line = null;
    var lines = rev && [];

    var index = 0, offset = 0;
    for (var i = start; i > 0; i--) {
        if (self.offsets[i] !== undefined) {
            index = i;
            offset = self.offsets[i];
            break;
        }
    }

    if (index === start) line = [];

    var buffer = new Buffer(self.bufsize);

    (function _read () {
        fs.read(self.fd, buffer, 0, buffer.length, offset,
        function (err, bytesRead, buf) {
            if (err) return cb(err);
            if (bytesRead === 0) {
                if (rev) {
                    lines.forEach(function (line) { cb(null, line) });
                }
                else if (line && line.length) cb(null, new Buffer(line));
                return cb(null, null);
            }

            for (var i = 0; i < bytesRead; i++) {
                if (index >= start) {
                    if (!line) line = [];
                    line.push(buf[i]);
                }

                if (buf[i] === 0x0a) {
                    self.offsets[++index] = offset + i + 1;

                    if (index === start) {
                        line = [];
                    }
                    else if (index > start) {
                        if (rev) {
                            lines.unshift(new Buffer(line));
                        }
                        else {
                            cb(null, new Buffer(line));
                        }
                        line = [];
                    }

                    if (index === end) {
                        found = true;
                        line = null;
                        if (rev) {
                            lines.forEach(function (line) { cb(null, line) });
                        }
                        cb(null, null);
                        break;
                    }
                }
            }

            if (!found) {
                offset += bytesRead;
                _read();
            }
        });
    })();
});

FA.prototype._stat = function (cb) {
    var self = this;
    fs.stat(self.file, function (err, stat) {
        if (err) return cb && cb(err);

        self.stat = stat;
        self.emit('stat', stat);
        if (cb) cb(null, stat);
    });
};

FA.prototype._readReverse = onopen(function (start, end, cb, rev) {
    var self = this;
    if (self.stat === undefined) {
        return self._stat(function (err) {
            if (err) cb(err);
            self._readReverse(start, end, cb, rev)
        });
    }

    var found = false;

    if (end === 0) return nextTick(function () {
        cb(null, null);
    });
    if (end === undefined) end = 0;
    var index = 0, offset = self.stat.size;

    if (end < 0 && start < 0) {
        for (var i = start; i >= 0; i--) {
            if (self.offsets[i] !== undefined) {
                index = i;
                offset = self.offsets[i];
                break;
            }
        }
    }
    else {
        for (var i = end; i < 0; i++) {
            if (self.offsets[i] !== undefined) {
                index = i;
                offset = self.offsets[i];
                break;
            }
        }
    }
    var buffer = new Buffer(self.bufsize);
    offset = Math.max(0, offset - buffer.length);

    var lines = null;
    if (index === end) lines = [];

    var firstNewline = true;
    (function _read () {
        fs.read(self.fd, buffer, 0, buffer.length, offset,
        function (err, bytesRead, buf) {
            if (err) return cb(err);
            if (bytesRead === 0 || offset < 0) {
                if (!rev) {
                    lines.forEach(function (xs) {
                        cb(null, new Buffer(xs));
                    });
                }
                else if (lines && lines.length) {
                    cb(null, new Buffer(lines[0]));
                }
                return cb(null, null);
            }

            for (var i = bytesRead - 1; i >= 0; i--) {
                if (buf[i] === 0x0a) {
                    if (firstNewline && i + 1 < bytesRead && index === 0) {
                        if (rev) cb(buf.slice(i+1, bytesRead))
                        else {
                            lines.unshift(buf.slice(i+1, bytesRead));
                            lines.splice(1);
                        }
                        self.offsets[--index] = offset + i - lines[0].length;
                    }
                    firstNewline = false;
                    self.offsets[--index] = offset + i;

                    if (index === end) {
                        lines = [];
                    }
                    else if (index === start - 1) {
                        found = true;
                        if (!rev && lines) {
                            lines.forEach(function (xs) {
                                cb(null, new Buffer(xs));
                            });
                        }
                        else if (lines && lines.length) {
                            cb(null, new Buffer(lines[0]));
                        }
                        cb(null, null);
                        lines = null;
                        break;
                    }
                    else if (index < end) {
                        if (!lines) lines = [];
                        if (rev && lines.length) {
                            cb(null, new Buffer(lines[0]));
                            lines.splice(1);
                        }
                        lines.unshift([]);
                    }
                }

                if (index < end) {
                    if (!lines) lines = [];
                    if (!lines[0]) lines[0] = [];
                    lines[0].unshift(buf[i]);
                }
            }

            if (!found) {
                offset -= bytesRead;
                _read();
            }
        });
    })();
});

FA.prototype.slice = function (start, end, cb) {
    var res;
    if (typeof start === 'function') {
        cb = start;
        start = 0;
        end = undefined;
    }
    if (typeof end === 'function') {
        cb = end;
        end = undefined;
    }
    if (typeof cb === 'function') res = [];

    var tr = through();
    this._read(start, end, function (err, line) {
        if (err) return tr.emit('error', err);
        else tr.push(line)

        if (cb && line === null) cb(null, res)
        else if (cb) res.push(line)
    });
    return tr;
};

FA.prototype.sliceReverse = function (start, end, cb) {
    var res;
    if (typeof start === 'function') {
        cb = start;
        start = 0;
        end = undefined;
    }
    if (typeof end === 'function') {
        cb = end;
        end = undefined;
    }
    if (typeof cb === 'function') res = [];

    var tr = through();
    this._read(start, end, function (err, line) {
        if (err) return tr.emit('error', err);
        else tr.push(line)

        if (cb && line === null) cb(null, res)
        else if (cb) res.push(line)
    }, true);
    return tr;
};

FA.prototype.follow = function (start, end) {
    var self = this;
    var tr = through();
    tr.close = function () {
        this.closed = true;
        this.emit('close');
    };

    var slice = this.slice(start, end);
    var writing = false;
    var changed = false;

    slice.once('end', function () {
        if (tr.closed) return;
        var w = fs.watch(self.file, { fd: self.fd });
        tr.once('close', function () { w.close() });
        self.once('close', function () { w.close() });

        if (!self.stat) self._stat(onstat);
        else onstat(null, self.stat);

        w.on('change', function (type) {
            if (type !== 'change') return;
            if (!writing) self._stat(onstat);
            changed = true;
        });

    });
    var lastStat = null;
    slice.pipe(tr, { end: false });
    self.once('close', function () { tr.push(null) });
    tr.once('close', function () { tr.push(null) });

    var out = tr.pipe(split()).pipe(through(function (line, _, next) {
        if (line.length) this.push(line + '\n');
        next();
    }));
    tr.on('error', function (err) { out.emit('error', err) });
    return out;

    function onstat (err, stat) {
        if (err) return tr.emit('error', err);
        if (!lastStat) return lastStat = stat;

        if (stat.size < lastStat.size) {
            tr.emit('truncate', lastStat.size - stat.size);
        }
        else if (stat.size > lastStat.size) {
            writing = true;
            var stream = fs.createReadStream(self.file, {
                start: lastStat.size,
                flags: self.flags,
                mode: self.mode,
                //autoClose: false,
                bufferSize: self.bufsize
            });
            stream.on('error', function (err) { tr.emit('error', err) });
            stream.on('end', function () {
                if (changed) self._stat(onstat);
                writing = false;
                changed = false;
            });
            stream.pipe(tr, { end: false });
        }

        lastStat = stat;
    }
};

FA.prototype.close = onopen(function () {
    var self = this;
    fs.close(self.fd, function () {
        self.emit('close');
    });
});

function onopen (f) {
    return function () {
        var self = this, args = arguments;
        if (self.fd === undefined) {
            self._onopen.push(function () {
                f.apply(self, args);
            });
        }
        else return f.apply(self, args);
    }
}
