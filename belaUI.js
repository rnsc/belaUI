/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2021 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const http = require('http');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');
const si = require('systeminformation');
const ws = require('ws');
const { exec, execSync, spawn, spawnSync } = require("child_process");
const fs = require('fs')
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const bcrypt = require('bcrypt');
const socVoltageFilePath = '/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_voltage0_input';
const socCurrentFilePath = '/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_current0_input';
const socTempFilePath = '/sys/class/thermal/thermal_zone0/temp';
const process = require('process');

const SETUP_FILE = 'setup.json';
const CONFIG_FILE = 'config.json';
const AUTH_TOKENS_FILE = 'auth_tokens.json';

const BCRYPT_ROUNDS = 10;
const ACTIVE_TO = 15000;

/* Read the config and setup files */
const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
console.log(setup);

const belacoderExec = setup.belacoder_path + '/belacoder';
const srtlaSendExec = setup.srtla_path + '/srtla_send';

function checkExecPath(path) {
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    console.log(`\n\n${path} not found, double check the settings in setup.json`);
    process.exit(1);
  }
}

checkExecPath(belacoderExec);
checkExecPath(srtlaSendExec);


/* Read the revision numbers */
function getRevision(cmd) {
  try {
    return execSync(cmd).toString().trim();
  } catch (err) {
    return 'unknown revision';
  }
}

const revisions = {};
revisions['belaUI'] = getRevision('git rev-parse --short HEAD');
revisions['belacoder'] = getRevision(`${belacoderExec} -v`);
revisions['srtla'] = getRevision(`${srtlaSendExec} -v`);
console.log(revisions);


const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
console.log(config);


/* tempTokens stores temporary login tokens in memory,
   persistentTokens stores login tokens to the disc */
const tempTokens = {};
let persistentTokens;
try {
  persistentTokens = JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf8'));
} catch(err) {
  persistentTokens = {};
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function savePersistentTokens() {
  fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens, null, 2));
}


/* Initialize the server */
const staticHttp = serveStatic("public");

const server = http.createServer(function(req, res) {
  const done = finalhandler(req, res);
  staticHttp(req, res, done);
});

const wss = new ws.Server({ server });
wss.on('connection', function connection(conn) {
  conn.lastActive = getms();

  if (!config.password_hash) {
    conn.send(buildMsg('status', {set_password: true}));
  }

  conn.on('message', function incoming(msg) {
    console.log(msg);
    try {
      msg = JSON.parse(msg);
      handleMessage(conn, msg);
    } catch (err) {
      console.log(`Error parsing client message: ${err.message}`);
    }
  });
});


/* Misc helpers */
function getms() {
  const [sec, ns] = process.hrtime();
  return sec * 1000 + Math.floor(ns / 1000 / 1000);
}


/* WS helpers */
function buildMsg(type, data, id = undefined) {
  const obj = {};
  obj[type] = data;
  obj.id = id;
  return JSON.stringify(obj);
}

function broadcastMsgLocal(type, data, activeMin = 0, except = undefined) {
  const msg = buildMsg(type, data);
  for (const c of wss.clients) {
    if (c !== except && c.lastActive >= activeMin && c.isAuthed) c.send(msg);
  }
  return msg;
}

function broadcastMsg(type, data, activeMin = 0) {
  const msg = broadcastMsgLocal(type, data, activeMin);
  if (remoteWs && remoteWs.isAuthed) {
    remoteWs.send(msg);
  }
}

function broadcastMsgExcept(conn, type, data) {
  broadcastMsgLocal(type, data, 0, conn);
  if (remoteWs && remoteWs.isAuthed) {
    const msg = buildMsg(type, data, conn.senderId);
    remoteWs.send(msg);
  }
}


/* Read the list of pipeline files */
function readDirAbsPath(dir) {
  const files = fs.readdirSync(dir);
  const basename = path.basename(dir);
  const pipelines = {};

  for (const f in files) {
    const name = basename + '/' + files[f];
    const id = crypto.createHash('sha1').update(name).digest('hex');
    const path = dir + files[f];
    pipelines[id] = {name: name, path: path};
  }

  return pipelines;
}

function getPipelines() {
  const ps = {};
  if (setup['hw'] == 'jetson') {
    Object.assign(ps, readDirAbsPath(setup['belacoder_path'] + '/pipeline/jetson/'));
  }
  Object.assign(ps, readDirAbsPath(setup['belacoder_path'] + '/pipeline/generic/'));

  return ps;
}

function searchPipelines(id) {
  const pipelines = getPipelines();
  if (pipelines[id]) return pipelines[id].path;
  return null;
}

// pipeline list in the format needed by the frontend
function getPipelineList() {
  const pipelines = getPipelines();
  const list = {};
  for (const id in pipelines) {
    list[id] = pipelines[id].name;
  }
  return list;
}

function getCurrentIfaceNetworkTx(name) {
  let tx_bytes = 0;
  try {
    tx_bytes = fs.readFileSync('/sys/class/net/'+ name +'/statistics/tx_bytes').toString().trim();
  } catch (e) {
    console.log(e);
  }
  return tx_bytes;
}

/* Network interface list */
let netif = {};
function updateNetif() {

  let foundNewInt = false;
  const newints = {};

  si.networkInterfaces(function(data) {
    for (let int of data) {
        const name = int.iface;
        if (name == 'lo' || name.match('^docker')) continue;

        let inet_addr = int.ip4;
        if (inet_addr == null) continue;

        let tx_bytes = getCurrentIfaceNetworkTx(name);
        if (netif[name]) {
          tp = txBytes - netif[name]['txb'];
        } else {
          tp = 0;
        }
        const enabled = (netif[name] && netif[name].enabled == false) ? false : true;
        newints[name] = {ip: inetAddr, txb: txBytes, tp, enabled};

        if (!netif[name] || netif[name].ip != inet_addr ) foundNewInt = true;

    }
    netif = newints;
  })
  broadcastMsg('netif', netif, Date.now() - ACTIVE_TO);

  if (foundNewInt && isStreaming) {
    updateSrtlaIps();
  }
}
updateNetif();
setInterval(updateNetif, 1000);

function countActiveNetif() {
  let count = 0;
  for (const int in netif) {
    if (netif[int].enabled) count++;
  }
  return count;
}

function handleNetif(conn, msg) {
  const int = netif[msg['name']];
  if (!int) return;

  if (int.ip != msg.ip) return;

  if (msg['enabled'] === true || msg['enabled'] === false) {
    if (!msg['enabled'] && int.enabled && countActiveNetif() == 1) {
      sendError(conn, "Can't disable all networks");
    } else {
      int.enabled = msg['enabled'];
      if (isStreaming) {
        updateSrtlaIps();
      }
    }
  }

  conn.send(buildMsg('netif', netif));
}

/* Remote */
const remoteProtocolVersion = 2;
const remoteEndpoint = 'wss://remote.belabox.net/ws/remote';
const remoteTimeout = 5000;
const remoteConnectTimeout = 10000;

let remoteWs = undefined;
let remoteStatusHandled = false;
function handleRemote(conn, msg) {
  for (const type in msg) {
    switch (type) {
      case 'auth/encoder':
        if (msg[type] === true) {
          conn.isAuthed = true;
          sendInitialStatus(conn)
          broadcastMsgLocal('status', {remote: true}, getms() - ACTIVE_TO);
          console.log('remote: authenticated');
        } else {
          broadcastMsgLocal('status', {remote: {error: 'key'}}, getms() - ACTIVE_TO);
          remoteStatusHandled = true;
          conn.terminate();
          console.log('remote: invalid key');
        }
        break;
    }
  }
}

let prevRemoteBindAddr = -1;
function getRemoteBindAddr() {
  const netList = Object.keys(netif);

  if (netList.length < 1) {
    prevRemoteBindAddr = -1;
    return undefined;
  }

  prevRemoteBindAddr++;
  if (prevRemoteBindAddr >= netList.length) {
    prevRemoteBindAddr = 0;
  }

  return netif[netList[prevRemoteBindAddr]].ip;
}

function remoteHandleMsg(msg) {
  try {
    msg = JSON.parse(msg);
    if (msg.remote) {
      handleRemote(this, msg.remote);
    }
    delete msg.remote;

    if (Object.keys(msg).length >= 1) {
      this.senderId = msg.id;
      handleMessage(this, msg, true);
      delete this.senderId;
    }

    this.lastActive = getms();
  } catch(err) {
    console.log(`Error handling remote message: ${err.message}`);
  }
}

let remoteConnectTimer;
function remoteClose() {
  remoteConnectTimer = setTimeout(remoteConnect, 1000);
  this.removeListener('close', remoteClose);
  this.removeListener('message', remoteHandleMsg);
  remoteWs = undefined;

  if (!remoteStatusHandled) {
    broadcastMsgLocal('status', {remote: {error: 'network'}}, getms() - ACTIVE_TO);
  }
}

function remoteConnect() {
  if (remoteConnectTimer !== undefined) {
    clearTimeout(remoteConnectTimer);
    remoteConnectTimer = undefined;
  }

  if (config.remote_key) {
    const bindIp = getRemoteBindAddr();
    if (!bindIp) {
      remoteConnectTimer = setTimeout(remoteConnect, 1000);
      return;
    }
    console.log(`remote: trying to connect via ${bindIp}`);

    remoteStatusHandled = false;
    remoteWs = new ws(remoteEndpoint, options = {localAddress: bindIp});
    remoteWs.isAuthed = false;
    // Set a longer initial connection timeout - mostly to deal with slow DNS
    remoteWs.lastActive = getms() + remoteConnectTimeout - remoteTimeout;
    remoteWs.on('error', function(err) {
      console.log('remote error: ' + err.message);
    });
    remoteWs.on('open', function() {
      const auth_msg = {remote: {'auth/encoder':
                        {key: config.remote_key, version: remoteProtocolVersion}
                       }};
      this.send(JSON.stringify(auth_msg));
    });
    remoteWs.on('close', remoteClose);
    remoteWs.on('message', remoteHandleMsg);
  }
}

function remoteKeepalive() {
  if (remoteWs) {
    if ((remoteWs.lastActive + remoteTimeout) < getms()) {
      remoteWs.terminate();
    }
  }
}
remoteConnect();
setInterval(remoteKeepalive, 1000);

function setRemoteKey(key) {
  config.remote_key = key;
  saveConfig();

  if (remoteWs) {
    remoteStatusHandled = true;
    remoteWs.terminate();
  }
  remoteConnect();

  broadcastMsg('config', config);
}


/* Hardware monitoring */
let sensors = {};
function updateSensorsJetson() {
  if (fs.existsSync(socVoltageFilePath)){
    try {
      let socVoltage = fs.readFileSync(socVoltageFilePath, 'utf8');
      socVoltage = parseInt(socVoltage) / 1000.0;
      socVoltage = `${socVoltage.toFixed(3)} V`;
      sensors['SoC voltage'] = socVoltage;
    } catch(err) {};
  } else {
    sensors['SoC voltage'] = null;
  }

  if (fs.existsSync(socCurrentFilePath)){
    try {
      let socCurrent = fs.readFileSync(socCurrentFilePath, 'utf8');
      socCurrent = parseInt(socCurrent) / 1000.0;
      socCurrent = `${socCurrent.toFixed(3)} A`;
      sensors['SoC current'] = socCurrent;
    } catch(err) {};
  } else {
    sensors['SoC current'] = null;
  }

  if(fs.existsSync(socTempFilePath)){
    try {
      let socTemp = fs.readFileSync(socTempFilePath, 'utf8');
      socTemp = parseInt(socTemp) / 1000.0;
      socTemp = `${socTemp.toFixed(1)} °C`;
      sensors['SoC temperature'] = socTemp;
    } catch (err) {};
  } else {
    sensors['SoC temperature'] = null;
  }

  broadcastMsg('sensors', sensors, getms() - ACTIVE_TO);
}
if (setup['hw'] == 'jetson') {
  updateSensorsJetson();
  setInterval(updateSensorsJetson, 1000);
}


/* Websocket packet handlers */
function sendError(conn, msg, id = undefined) {
  if (id === undefined) id = conn.senderId;
  conn.send(buildMsg('error', {msg: msg}, id));
}

function startError(conn, msg, id = undefined) {
  sendError(conn, msg, id);
  conn.send(buildMsg('status', {is_streaming: false}));
  return false;
}

function setBitrate(params) {
  const minBr = 300; // Kbps

  if (params.max_br == undefined) return null;
  if (params.max_br < minBr || params.max_br > 12000) return null;

  config.max_br = params.max_br;
  saveConfig();

  fs.writeFileSync(setup.bitrate_file, minBr*1000 + "\n"
                   + config.max_br*1000 + "\n");

  spawnSync("killall", ['-HUP', "belacoder"], { detached: true});

  return config.max_br;
}

function updateConfig(conn, params, callback) {
  // delay
  if (params.delay == undefined)
    return startError(conn, "audio delay not specified");
  if (params.delay < -2000 || params.delay > 2000)
    return startError(conn, "invalid delay " + params.delay);

  // pipeline
  if (params.pipeline == undefined)
    return startError(conn, "pipeline not specified");
  let pipeline = searchPipelines(params.pipeline);
  if (pipeline == null)
    return startError(conn, "pipeline not found");

  // bitrate
  let bitrate = setBitrate(params);
  if (bitrate == null)
    return startError(conn, "invalid bitrate range: ");

  // srt latency
  if (params.srt_latency == undefined)
    return startError(conn, "SRT latency not specified");
  if (params.srt_latency < 100 || params.srt_latency > 10000)
    return startError(conn, "invalid SRT latency " + params.srt_latency + " ms");

  // srt streamid
  if (params.srt_streamid == undefined)
    return startError(conn, "SRT streamid not specified");

  // srtla addr & port
  if (params.srtla_addr == undefined)
    return startError(conn, "SRTLA address not specified");
  if (params.srtla_port == undefined)
    return startError(conn, "SRTLA port not specified");
  if (params.srtla_port <= 0 || params.srtla_port > 0xFFFF)
    return startError(conn, "invalid SRTLA port " + params.srtla_port);

  // Save the sender's ID in case we'll have to use it in the exception handler
  const senderId = conn.senderId;
  dns.lookup(params.srtla_addr, function(err, address, family) {
    if (err == null) {
      config.delay = params.delay;
      config.pipeline = params.pipeline;
      config.max_br = params.max_br;
      config.srt_latency = params.srt_latency;
      config.srt_streamid = params.srt_streamid;
      config.srtla_addr = params.srtla_addr;
      config.srtla_port = params.srtla_port;

      saveConfig();

      broadcastMsgExcept(conn, 'config', config);
      
      callback(pipeline);
    } else {
      startError(conn, "failed to resolve SRTLA addr " + params.srtla_addr, senderId);
    }
  });
}


/* Streaming status */
let isStreaming = false;
function updateStatus(status) {
  isStreaming = status;
  broadcastMsg('status', {is_streaming: isStreaming});
}

function genSrtlaIpList() {
  let list = "";
  let count = 0;

  for (i in netif) {
    if (netif[i].enabled) {
      list += netif[i].ip + "\n";
      count++;
    }
  }
  fs.writeFileSync(setup.ips_file, list);

  return count;
}

function updateSrtlaIps() {
  genSrtlaIpList();
  spawnSync("killall", ['-HUP', "srtla_send"], { detached: true});
}

function spawnStreamingLoop(command, args, cooldown = 100) {
  if (!isStreaming) return;

  const process = spawn(command, args, { stdio: 'inherit' });
  process.on('exit', function(code) {
    setTimeout(function() {
      spawnStreamingLoop(command, args, cooldown);
    }, cooldown);
  })
}

function start(conn, params) {
  const senderId = conn.senderId;
  updateConfig(conn, params, function(pipeline) {
    if (genSrtlaIpList() < 1) {
      startError(conn, "Failed to start, no available network connections", senderId);
      return;
    }
    isStreaming = true;

    spawnStreamingLoop(srtlaSendExec, [
												9000,
												config.srtla_addr,
												config.srtla_port,
												setup.ips_file
											]);

    const belacoderArgs = [
                            pipeline,
                            '127.0.0.1',
                            '9000',
                            '-d', config.delay,
                            '-b', setup.bitrate_file,
                            '-l', config.srt_latency,
                          ];
    if (config.srt_streamid != '') {
      belacoderArgs.push('-s');
      belacoderArgs.push(config.srt_streamid);
    }
    spawnStreamingLoop(belacoderExec, belacoderArgs, 2000);

    updateStatus(true);
  });
}

function stop() {
  updateStatus(false);
  spawnSync("killall", ["srtla_send"], {detached: true});
  spawnSync("killall", ["belacoder"], {detached: true});
}
stop(); // make sure we didn't inherit an orphan runner process


/* Misc commands */
function command(conn, cmd) {
  switch(cmd) {
    case 'poweroff':
      spawnSync("poweroff", {detached: true});
      break;
    case 'reboot':
      spawnSync("reboot", {detached: true});
      break;
  }
}

function handleConfig(conn, msg, isRemote) {
  // setPassword does its own authentication
  for (const type in msg) {
    switch(type) {
      case 'password':
        setPassword(conn, msg[type], isRemote);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'remote_key':
        setRemoteKey(msg[type]);
        break;
    }
  }
}


/* Authentication */
function setPassword(conn, password, isRemote) {
  if (conn.isAuthed || (!isRemote && !config.password_hash)) {
    const minLen = 8;
    if (password.length < minLen) {
      sendError(conn, `Minimum password length: ${minLen} characters`);
      return;
    }
    config.password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    delete config.password;
    saveConfig();
  }
}

function genAuthToken(isPersistent) {
  const token = crypto.randomBytes(32).toString('base64');
  if (isPersistent) {
    persistentTokens[token] = true;
    savePersistentTokens();
  } else {
    tempTokens[token] = true;
  }
  return token;
}

function sendInitialStatus(conn) {
  conn.send(buildMsg('config', config));
  conn.send(buildMsg('pipelines', getPipelineList()));
  conn.send(buildMsg('status', {is_streaming: isStreaming}));
  conn.send(buildMsg('netif', netif));
  conn.send(buildMsg('sensors', sensors));
  conn.send(buildMsg('revisions', revisions));
}

function connAuth(conn, sendToken) {
  conn.isAuthed = true;
  let result = {success: true};
  if (sendToken != undefined) {
    result['auth_token'] = sendToken;
  }
  conn.send(buildMsg('auth', result));
  sendInitialStatus(conn);
}

function tryAuth(conn, msg) {
  if (typeof(msg.password) == 'string' && config.enable_auth) {
    bcrypt.compare(msg.password, config.password_hash, function(err, match) {
      if (match == true && err == undefined) {
        conn.authToken = genAuthToken(msg.persistent_token);
        connAuth(conn, conn.authToken);
      } else {
        sendError(conn, "Invalid password");
      }
    });
  } else if (typeof(msg.token) == 'string' && config.enable_auth) {
    if (tempTokens[msg.token] || persistentTokens[msg.token]) {
      connAuth(conn);
      conn.authToken = msg.token;
    } else {
      conn.send(buildMsg('auth', {success: false}));
    }
  } else if (!config.enable_auth) {
    conn.authToken = genAuthToken(true)
    connAuth(conn, conn.authToken)
  }
}


function handleMessage(conn, msg, isRemote = false) {
  if (!isRemote) {
    for (const type in msg) {
      switch(type) {
        case 'auth':
          tryAuth(conn, msg[type]);
          break;
      }
    }
  }

  if (!conn.isAuthed && config.enable_auth) return;

  for (const type in msg) {
    switch(type) {
      case 'keepalive':
        // NOP - conn.lastActive is updated when receiving any valid message
        break;
      case 'start':
        start(conn, msg[type]);
        break;
      case 'stop':
        stop();
        break;
      case 'bitrate':
        if (isStreaming) {
          const br = setBitrate(msg[type]);
          if (br != null) {
            broadcastMsgExcept(conn, 'bitrate', {max_br: br});
          }
        }
        break;
      case 'command':
        command(conn, msg[type]);
        break;
      case 'netif':
        handleNetif(conn, msg[type]);
        break;
      case 'logout':
        if (conn.authToken) {
          delete tempTokens[conn.authToken];
          if (persistentTokens[conn.authToken]) {
            delete persistentTokens[conn.authToken];
            savePersistentTokens();
          }
        }
        delete conn.isAuthed;
        delete conn.authToken;

        break;
    }
  }

  conn.lastActive = getms();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

server.listen(80);

if (config.autostart) {

  var WebSocketClient = require('websocket').client;
  var client = new WebSocketClient();

  client.on('connectFailed', function(error) {
      console.log('Connect Error: ' + error.toString());
  });

  client.on('connect', async function(connection) {
    console.log('WebSocket Client Connected');
    await sleep(config.autostart_delay_ms);
    connection.send(JSON.stringify({start: config}))
  });

  client.connect('ws://localhost/', 'start');
}
