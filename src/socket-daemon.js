/*
* Copyright 2018 ARDUINO SA (http://www.arduino.cc/)
* This file is part of arduino-create-agent-js-client.
* Copyright (c) 2018
* Authors: Alberto Iannaccone, Stefania Mellai, Gabriele Destefanis
*
* This software is released under:
* The GNU General Public License, which covers the main part of
* arduino-create-agent-js-client
* The terms of this license can be found at:
* https://www.gnu.org/licenses/gpl-3.0.en.html
*
* You can be released from the requirements of the above licenses by purchasing
* a commercial license. Buying such a license is mandatory if you want to modify or
* otherwise use the software for commercial activities involving the Arduino
* software without disclosing the source code of your own applications. To purchase
* a commercial license, send an email to license@arduino.cc.
*
*/

import io from 'socket.io-client';
import semVerCompare from 'semver-compare';
import { detect } from 'detect-browser';

import { timer } from 'rxjs';
import { filter, takeUntil, first } from 'rxjs/operators';

import Daemon from './daemon';

// Required agent version
const MIN_VERSION = '1.1.76';
const browser = detect();
const POLLING_INTERVAL = 2500;
const UPLOAD_DONE_TIMER = 5000;

const PROTOCOL = {
  HTTP: 'http',
  HTTPS: 'https'
};

const LOOPBACK_ADDRESS = `${PROTOCOL.HTTP}://127.0.0.1`;
const LOOPBACK_HOST = `${PROTOCOL.HTTPS}://localhost`;
const LOOKUP_PORT_START = 8991;
const LOOKUP_PORT_END = 9000;
let orderedPluginAddresses = [LOOPBACK_ADDRESS, LOOPBACK_HOST];

const CANT_FIND_AGENT_MESSAGE = 'Arduino Create Agent cannot be found';

let updateAttempts = 0;

if (browser.name !== 'chrome' && browser.name !== 'firefox') {
  orderedPluginAddresses = [LOOPBACK_HOST, LOOPBACK_ADDRESS];
}

export default class SocketDaemon extends Daemon {
  constructor() {
    super();
    this.selectedProtocol = PROTOCOL.HTTP;
    this.socket = null;
    this.pluginURL = null;

    this.openChannel(() => this.socket.emit('command', 'list'));

    this.agentFound
      .subscribe(agentFound => {
        if (agentFound) {
          this._wsConnect();
        }
        else {
          this.findAgent();
        }
      });
  }

  initSocket() {
    this.socket.on('message', message => {
      try {
        this.appMessages.next(JSON.parse(message));
      }
      catch (SyntaxError) {
        this.appMessages.next(message);
      }
    });
  }

  notifyDownloadError(err) {
    this.downloading.next({ status: this.DOWNLOAD_ERROR, err });
  }

  /**
   * Look for the agent endpoint.
   * First search in LOOPBACK_ADDRESS, after in LOOPBACK_HOST if in Chrome or Firefox, otherwise vice versa.
   */
  findAgent() {
    this._tryPorts(orderedPluginAddresses[0])
      .catch(() => this._tryPorts(orderedPluginAddresses[1]))
      .then(() => this.agentFound.next(true))
      .catch(() => timer(POLLING_INTERVAL).subscribe(() => this.findAgent()));
  }

  /**
   * Try ports for the selected host. From LOOKUP_PORT_START to LOOKUP_PORT_END
   * @param {string} host - The host value (LOOPBACK_ADDRESS or LOOPBACK_HOST).
   * @return {Promise} info - A promise resolving with the agent info values.
   */
  _tryPorts(host) {
    const pluginLookups = [];

    for (let port = LOOKUP_PORT_START; port < LOOKUP_PORT_END; port += 1) {
      pluginLookups.push(fetch(`${host}:${port}/info`)
        .then(response => response.json().then(data => ({ response, data })))
        .catch(() => Promise.resolve(false)));
      // We expect most of those call to fail, because there's only one agent
      // So we have to resolve them with a false value to let the Promise.all catch all the deferred data
    }

    return Promise.all(pluginLookups)
      .then(responses => {
        const found = responses.some(r => {
          if (r && r.response && r.response.status === 200) {
            this.agentInfo = r.data;

            if (this.agentInfo.update_url.indexOf('downloads.arduino.cc') === -1) {
              this.error.next('unofficial plugin');
            }

            if (r.response.url.indexOf(PROTOCOL.HTTPS) === 0) {
              this.selectedProtocol = PROTOCOL.HTTPS;
            }
            else {
              // Protocol http, force 127.0.0.1 for old agent versions too
              this.agentInfo[this.selectedProtocol] = this.agentInfo[this.selectedProtocol].replace('localhost', '127.0.0.1');
            }
            this.pluginURL = this.agentInfo[this.selectedProtocol];
            return true;
          }
          return false;
        });

        if (found) {
          if (this.agentInfo.version && (semVerCompare(this.agentInfo.version, MIN_VERSION) >= 0 || this.agentInfo.version.indexOf('dev') !== -1)) {
            return this.agentInfo;
          }

          updateAttempts += 1;
          if (updateAttempts === 0) {
            return this.update();
          }
          if (updateAttempts < 3) {
            return timer(10000).subscribe(() => this.update());
          }
          this.error.next('plugin version incompatible');
          return Promise.reject(new Error('plugin version incompatible'));
        }

        // Set channelOpen false for the first time
        if (this.channelOpen.getValue() === null) {
          this.channelOpen.next(false);
        }
        return Promise.reject(new Error(`${CANT_FIND_AGENT_MESSAGE} at ${host}`));
      });
  }

  /**
   * Uses the websocket protocol to connect to the agent
   */
  _wsConnect() {
    const wsProtocol = this.selectedProtocol === PROTOCOL.HTTPS ? 'wss' : 'ws';
    const address = this.agentInfo[wsProtocol];

    // Reset
    if (this.socket) {
      this.socket.destroy();
      delete this.socket;
      this.socket = null;
    }

    this.socket = io(address);

    this.socket.on('connect', () => {
      // On connect download windows drivers which are indispensable for detection of boards
      this.downloadTool('windows-drivers', 'latest', 'arduino');
      this.downloadTool('bossac', '1.7.0', 'arduino');

      this.initSocket();

      this.channelOpen.next(true);
    });

    this.socket.on('error', error => this.error.next(error));

    this.socket.on('disconnect', () => {
      this.channelOpen.next(false);
    });
  }

  handleAppMessage(message) {
    // Result of a list command
    if (message.Ports) {
      this.handleListMessage(message);
    }
    // Serial monitor message
    if (message.D) {
      this.serialMonitorMessages.next(message.D);
    }

    if (message.ProgrammerStatus) {
      this.handleUploadMessage(message);
    }

    if (message.DownloadStatus) {
      this.handleDownloadMessage(message);
    }

    if (message.Err) {
      this.uploading.next({ status: this.UPLOAD_ERROR, err: message.Err });
    }

    if (message.Error) {
      if (message.Error.indexOf('trying to close') !== -1) {
        // https://github.com/arduino/arduino-create-agent#openclose-ports
        this.serialMonitorOpened.next(false);
      }
    }
  }

  handleListMessage(message) {
    const lastDevices = this.devicesList.getValue();
    if (message.Network && !Daemon.devicesListAreEquals(lastDevices.network, message.Ports)) {
      this.devicesList.next({
        serial: lastDevices.serial,
        network: message.Ports
      });
    }
    else if (!message.Network && !Daemon.devicesListAreEquals(lastDevices.serial, message.Ports)) {
      this.devicesList.next({
        serial: message.Ports,
        network: lastDevices.network
      });
    }
  }

  /**
   * Check the agent version and call the update if needed.
   */
  update() {
    return fetch(`${this.agentInfo[this.selectedProtocol]}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    })
      .then(result => result.json())
      .then(response => {
        if (!response.ok) {
          if (response && response.error && (response.error.indexOf('proxy') !== -1 || response.error.indexOf('dial tcp') !== -1)) {
            this.error.next('proxy error');
            return new Error('proxy error');
          }
        }
        // We reject the promise because the daemon will be restarted, we need to continue looking for the port
        return Promise.reject();
      })
      .catch(() => {
        console.log('update plugin failed');
      });
  }

  /**
   * Pauses the plugin
   * @return {Promise}
   */
  stopPlugin() {
    if (this.agentFound.getValue()) {
      return fetch(`${this.agentInfo[this.selectedProtocol]}/pause`, { method: 'POST' });
    }
  }

  /**
   * Send 'close' command to all the available serial ports
   */
  closeAllPorts() {
    const devices = this.devicesList.getValue().serial;
    devices.forEach(device => {
      this.socket.emit('command', `close ${device.Name}`);
    });
  }

  /**
   * Send 'message' to serial port
   * @param {string} port the port name
   * @param {string} message the text to be sent to serial
   */
  writeSerial(port, message) {
    this.socket.emit('command', `send ${port} ${message}`);
  }

  /**
   * Request serial port open
   * @param {string} port the port name
   */
  openSerialMonitor(port, baudrate) {
    const serialPort = this.devicesList.getValue().serial.find(p => p.Name === port);
    if (!serialPort) {
      return this.serialMonitorOpened.error(new Error(`Can't find board at ${port}`));
    }
    if (this.uploading.getValue().status === this.UPLOAD_IN_PROGRESS || serialPort.IsOpen) {
      return;
    }

    this.appMessages
      .pipe(takeUntil(this.serialMonitorOpened.pipe(filter(open => open))))
      .subscribe(message => {
        if (message.Cmd === 'Open') {
          this.serialMonitorOpened.next(true);
        }
        if (message.Cmd === 'OpenFail') {
          this.serialMonitorOpened.error(new Error(`Failed to open serial monitor at ${port}`));
        }
      });

    this.socket.emit('command', `open ${port} ${baudrate} timed`);
  }

  /**
   * Request serial port close
   * @param {string} port the port name
   */
  closeSerialMonitor(port) {
    const serialPort = this.devicesList.getValue().serial.find(p => p.Name === port);
    if (!serialPort) {
      return this.serialMonitorOpened.error(new Error(`Can't find board at ${port}`));
    }
    if (!serialPort.IsOpen) {
      return;
    }

    this.appMessages
      .pipe(takeUntil(this.serialMonitorOpened.pipe(filter(open => !open))))
      .subscribe(message => {
        if (message.Cmd === 'Close') {
          this.serialMonitorOpened.next(false);
        }
        if (message.Cmd === 'CloseFail') {
          this.serialMonitorOpened.error(new Error(`Failed to close serial monitor at ${port}`));
        }
      });
    this.socket.emit('command', `close ${port}`);
  }

  handleUploadMessage(message) {
    if (message.Flash === 'Ok' && message.ProgrammerStatus === 'Done') {
      // After the upload is completed the port goes down for a while, so we have to wait a few seconds
      return timer(UPLOAD_DONE_TIMER).subscribe(() => this.uploading.next({ status: this.UPLOAD_DONE, msg: message.Flash }));
    }
    switch (message.ProgrammerStatus) {
      case 'Starting':
        this.uploading.next({ status: this.UPLOAD_IN_PROGRESS, msg: `Programming with: ${message.Cmd}` });
        break;
      case 'Busy':
        this.uploading.next({ status: this.UPLOAD_IN_PROGRESS, msg: message.Msg });
        break;
      case 'Error':
        this.uploading.next({ status: this.UPLOAD_ERROR, err: message.Msg });
        break;
      case 'Killed':
        this.uploading.next({ status: this.UPLOAD_IN_PROGRESS, msg: `terminated by user` });
        this.uploading.next({ status: this.UPLOAD_ERROR, err: `terminated by user` });
        break;
      case 'Error 404 Not Found':
        this.uploading.next({ status: this.UPLOAD_ERROR, err: message.Msg });
        break;
      default:
        this.uploading.next({ status: this.UPLOAD_IN_PROGRESS, msg: message.Msg });
    }
  }

  handleDownloadMessage(message) {
    switch (message.DownloadStatus) {
      case 'Pending':
        this.downloading.next({ status: this.DOWNLOAD_IN_PROGRESS, msg: message.Msg });
        break;
      case 'Success':
        this.downloading.next({ status: this.DOWNLOAD_DONE, msg: message.Msg });
        break;
      case 'Error':
        this.downloading.next({ status: this.DOWNLOAD_ERROR, err: message.Msg });
        break;
      default:
        this.downloading.next({ status: this.DOWNLOAD_IN_PROGRESS, msg: message.Msg });
    }
  }

  /**
   * Perform an upload via http on the daemon
   * @param {Object} target = {
   *   board: "name of the board",
   *   port: "port of the board",
   *   auth_user: "Optional user to use as authentication",
   *   auth_pass: "Optional pass to use as authentication"
   *   auth_key: "Optional private key",
   *   auth_port: "Optional alternative port (default 22)"
   *   network: true or false
   * }
   * @param {Object} data = {
   *  commandline: "commandline to execute",
      signature: "signature of the commandline",
   *  files: [
   *   {name: "Name of a file to upload on the device", data: 'base64data'}
   *  ],
   *  options: {}
   * }
   */
  upload(target, data) {
    if (!target.network) {
      this.closeSerialMonitor(target.port);
    }
    this.uploading.next({ status: this.UPLOAD_IN_PROGRESS });

    if (data.files.length === 0) { // At least one file to upload
      this.uploading.next({ status: this.UPLOAD_ERROR, err: 'You need at least one file to upload' });
      return;
    }

    // Main file
    const file = data.files[0];
    file.name = file.name.split('/');
    file.name = file.name[file.name.length - 1];

    const payload = {
      board: target.board,
      port: target.port,
      commandline: data.commandline,
      signature: data.signature,
      hex: file.data,
      filename: file.name,
      extra: {
        auth: {
          username: target.auth_user,
          password: target.auth_pass,
          private_key: target.auth_key,
          port: target.auth_port
        },
        wait_for_upload_port: data.options.wait_for_upload_port === 'true' || data.options.wait_for_upload_port === true,
        use_1200bps_touch: data.options.use_1200bps_touch === 'true' || data.options.use_1200bps_touch === true,
        network: target.network,
        ssh: target.ssh,
        params_verbose: data.options.param_verbose,
        params_quiet: data.options.param_quiet,
        verbose: data.options.verbose
      },
      extrafiles: data.extrafiles || []
    };

    for (let i = 1; i < data.files.length; i += 1) {
      payload.extrafiles.push({ filename: data.files[i].name, hex: data.files[i].data });
    }

    this.serialMonitorOpened.pipe(filter(open => !open))
      .pipe(first())
      .subscribe(() => {
        fetch(`${this.pluginURL}/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          },
          body: JSON.stringify(payload)
        })
          .catch(error => {
            this.uploading.next({ status: this.UPLOAD_ERROR, err: error });
          });
      });
  }

  /**
   * Download tool
   * @param {string} toolName
   * @param {string} toolVersion
   * @param {string} packageName
   * @param {string} replacementStrategy
   */
  downloadTool(toolName, toolVersion, packageName, replacementStrategy = 'keep') {
    this.downloading.next({ status: this.DOWNLOAD_IN_PROGRESS });
    this.socket.emit('command', `downloadtool ${toolName} ${toolVersion} ${packageName} ${replacementStrategy}`);
  }

  /**
   * Interrupt upload
   */
  stopUploadCommand() {
    this.uploading.next({
      status: this.UPLOAD_ERROR,
      err: 'upload stopped'
    });
    this.socket.emit('command', 'killupload');
  }
}
