;
(function (window, undefined) {

    var _version = '1.1.2';
    var _code = require('./status').code;
    var _utils = require('./utils').utils;
    var _msg = require('./message');
    var _message = _msg._msg;
    var _msgHash = {};

    window.URL = window.URL || window.webkitURL || window.mozURL || window.msURL;

    if (window.XDomainRequest) {
        XDomainRequest.prototype.oldsend = XDomainRequest.prototype.send;
        XDomainRequest.prototype.send = function () {
            XDomainRequest.prototype.oldsend.apply(this, arguments);
            this.readyState = 2;
        };
    }

    Strophe.Request.prototype._newXHR = function () {
        var xhr = _utils.xmlrequest(true);
        if (xhr.overrideMimeType) {
            xhr.overrideMimeType('text/xml');
        }
        //TODO: need to be verified in IE8
        xhr.onreadystatechange = Strophe.Request.func.bind(null, Strophe.Request);
        return xhr;
    };


    /**
     *
     * Strophe.Websocket has a bug while logout:
     * 1.send: <presence xmlns='jabber:client' type='unavailable'/> is ok;
     * 2.send: <close xmlns='urn:ietf:params:xml:ns:xmpp-framing'/> will cause a problem,log as follows:
     * WebSocket connection to 'ws://im-api.easemob.com/ws/' failed: Data frame received after close_connect @ strophe.js:5292connect @ strophe.js:2491_login @ websdk-1.1.2.js:278suc @ websdk-1.1.2.js:636xhr.onreadystatechange @ websdk-1.1.2.js:2582
     * 3 "Websocket error [object Event]"
     * _changeConnectStatus
     * onError Object {type: 7, msg: "The WebSocket connection could not be established or was disconnected.", reconnect: true}
     *
     * this will trigger socket.onError, therefore _doDisconnect again.
     * Fix it by overide  _disconnect and _onMessage
     * as follows:
     */
    Strophe.Websocket.prototype._closeSocket = function () {
        if (this.socket) {
            var me = this;
            setTimeout(function () {
                try {
                    me.socket.close();
                } catch (e) {
                }
            }, 0);
        } else {
            this.socket = null;
        }
    };

    Strophe.Websocket.prototype._disconnect = function (pres) {
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
            if (pres) {
                this._conn.send(pres);
            }
            var close = $build("close", {"xmlns": Strophe.NS.FRAMING});
            this._conn.xmlOutput(close);
            var closeString = Strophe.serialize(close);
            this._conn.rawOutput(closeString);
            try {
                this.socket.send(closeString);
            } catch (e) {
                Strophe.info("Couldn't send <close /> tag.");
            }
        }
        // should not call _doDisconnect() at this point.
        // _onMessage will call it when receive the <close />
        // this._conn._doDisconnect();
    };

    Strophe.Websocket.prototype._onMessage = function (message) {
        if (WebIM.config.isDebug) {
            console.log(ts() + 'recv:', message.data);
        }
        var elem, data;
        // check for closing stream
        // var close = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing" />';
        // if (message.data === close) {
        //     this._conn.rawInput(close);
        //     this._conn.xmlInput(message);
        //     if (!this._conn.disconnecting) {
        //         this._conn._doDisconnect();
        //     }
        //     return;
        //
        // send and receive close xml: <close xmlns='urn:ietf:params:xml:ns:xmpp-framing'/>
        // so we can't judge whether message.data equals close by === simply.
        if (message.data.indexOf("<close ") === 0) {
            elem = new DOMParser().parseFromString(message.data, "text/xml").documentElement;
            var see_uri = elem.getAttribute("see-other-uri");
            if (see_uri) {
                this._conn._changeConnectStatus(Strophe.Status.REDIRECT, "Received see-other-uri, resetting connection");
                this._conn.reset();
                this._conn.service = see_uri;
                this._connect();
            } else {
                // if (!this._conn.disconnecting) {
                this._conn._doDisconnect();
                // }
            }
            return;
        } else if (message.data.search("<open ") === 0) {
            // This handles stream restarts
            elem = new DOMParser().parseFromString(message.data, "text/xml").documentElement;
            if (!this._handleStreamStart(elem)) {
                return;
            }
        } else {
            data = this._streamWrap(message.data);
            elem = new DOMParser().parseFromString(data, "text/xml").documentElement;
        }

        if (this._check_streamerror(elem, Strophe.Status.ERROR)) {
            return;
        }

        //handle unavailable presence stanza before disconnecting
        if (this._conn.disconnecting &&
            elem.firstChild.nodeName === "presence" &&
            elem.firstChild.getAttribute("type") === "unavailable") {
            this._conn.xmlInput(elem);
            this._conn.rawInput(Strophe.serialize(elem));
            // if we are already disconnecting we will ignore the unavailable stanza and
            // wait for the </stream:stream> tag before we close the connection
            return;
        }
        this._conn._dataRecv(elem, message.data);
    };


    var _listenNetwork = function (onlineCallback, offlineCallback) {

        if (window.addEventListener) {
            window.addEventListener('online', onlineCallback);
            window.addEventListener('offline', offlineCallback);

        } else if (window.attachEvent) {
            if (document.body) {
                document.body.attachEvent('ononline', onlineCallback);
                document.body.attachEvent('onoffline', offlineCallback);
            } else {
                window.attachEvent('load', function () {
                    document.body.attachEvent('ononline', onlineCallback);
                    document.body.attachEvent('onoffline', offlineCallback);
                });
            }
        } else {
            /*var onlineTmp = window.ononline;
             var offlineTmp = window.onoffline;

             window.attachEvent('ononline', function () {
             try {
             typeof onlineTmp === 'function' && onlineTmp();
             } catch ( e ) {}
             onlineCallback();
             });
             window.attachEvent('onoffline', function () {
             try {
             typeof offlineTmp === 'function' && offlineTmp();
             } catch ( e ) {}
             offlineCallback();
             });*/
        }
    };

    var _parseRoom = function (result) {
        var rooms = [];
        var items = result.getElementsByTagName('item');
        if (items) {
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var roomJid = item.getAttribute('jid');
                var tmp = roomJid.split('@')[0];
                var room = {
                    jid: roomJid,
                    name: item.getAttribute('name'),
                    roomId: tmp.split('_')[1]
                };
                rooms.push(room);
            }
        }
        return rooms;
    };

    var _parseRoomOccupants = function (result) {
        var occupants = [];
        var items = result.getElementsByTagName('item');
        if (items) {
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var room = {
                    jid: item.getAttribute('jid'),
                    name: item.getAttribute('name')
                };
                occupants.push(room);
            }
        }
        return occupants;
    };

    var _parseResponseMessage = function (msginfo) {
        var parseMsgData = {errorMsg: true, data: []};

        var msgBodies = msginfo.getElementsByTagName('body');
        if (msgBodies) {
            for (var i = 0; i < msgBodies.length; i++) {
                var msgBody = msgBodies[i];
                var childNodes = msgBody.childNodes;
                if (childNodes && childNodes.length > 0) {
                    var childNode = msgBody.childNodes[0];
                    if (childNode.nodeType == Strophe.ElementType.TEXT) {
                        var jsondata = childNode.wholeText || childNode.nodeValue;
                        jsondata = jsondata.replace('\n', '<br>');
                        try {
                            var data = eval('(' + jsondata + ')');
                            parseMsgData.errorMsg = false;
                            parseMsgData.data = [data];
                        } catch (e) {
                        }
                    }
                }
            }

            var delayTags = msginfo.getElementsByTagName('delay');
            if (delayTags && delayTags.length > 0) {
                var delayTag = delayTags[0];
                var delayMsgTime = delayTag.getAttribute('stamp');
                if (delayMsgTime) {
                    parseMsgData.delayTimeStamp = delayMsgTime;
                }
            }
        } else {
            var childrens = msginfo.childNodes;
            if (childrens && childrens.length > 0) {
                var child = msginfo.childNodes[0];
                if (child.nodeType == Strophe.ElementType.TEXT) {
                    try {
                        var data = eval('(' + child.nodeValue + ')');
                        parseMsgData.errorMsg = false;
                        parseMsgData.data = [data];
                    } catch (e) {
                    }
                }
            }
        }
        return parseMsgData;
    };

    var _parseNameFromJidFn = function (jid, domain) {
        domain = domain || '';
        var tempstr = jid;
        var findex = tempstr.indexOf('_');

        if (findex !== -1) {
            tempstr = tempstr.substring(findex + 1);
        }
        var atindex = tempstr.indexOf('@' + domain);
        if (atindex !== -1) {
            tempstr = tempstr.substring(0, atindex);
        }
        return tempstr;
    };

    var _parseFriend = function (queryTag) {
        var rouster = [];
        var items = queryTag.getElementsByTagName('item');
        if (items) {
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var jid = item.getAttribute('jid');
                if (!jid) {
                    continue;
                }
                var subscription = item.getAttribute('subscription');
                var friend = {
                    subscription: subscription,
                    jid: jid
                };
                var ask = item.getAttribute('ask');
                if (ask) {
                    friend.ask = ask;
                }
                var name = item.getAttribute('name');
                if (name) {
                    friend.name = name;
                } else {
                    var n = _parseNameFromJidFn(jid);
                    friend.name = n;
                }
                var groups = [];
                Strophe.forEachChild(item, 'group', function (group) {
                    groups.push(Strophe.getText(group));
                });
                friend.groups = groups;
                rouster.push(friend);
            }
        }
        return rouster;
    };

    var _login = function (options, conn) {
        var accessToken = options.access_token || '';
        if (accessToken == '') {
            var loginfo = _utils.stringify(options);
            conn.onError({
                type: _code.WEBIM_CONNCTION_OPEN_USERGRID_ERROR,
                data: options,
                xhr: xhr
            });
            return;
        }
        conn.context.accessToken = options.access_token;
        conn.context.accessTokenExpires = options.expires_in;
        var stropheConn = null;
        if (conn.isOpening() && conn.context.stropheConn) {
            stropheConn = conn.context.stropheConn;
        } else if (conn.isOpened() && conn.context.stropheConn) {
            return;
        } else {
            stropheConn = new Strophe.Connection(conn.url, {
                inactivity: conn.inactivity,
                maxRetries: conn.maxRetries,
                pollingTime: conn.pollingTime
            });
        }
        var callback = function (status, msg) {
            _loginCallback(status, msg, conn);
        };

        conn.context.stropheConn = stropheConn;
        if (conn.route) {
            stropheConn.connect(conn.context.jid, '$t$' + accessToken, callback, conn.wait, conn.hold, conn.route);
        } else {
            stropheConn.connect(conn.context.jid, '$t$' + accessToken, callback, conn.wait, conn.hold);
        }
    };

    var _parseMessageType = function (msginfo) {
        var msgtype = 'normal';
        var receiveinfo = msginfo.getElementsByTagName('received');
        if (receiveinfo && receiveinfo.length > 0 && receiveinfo[0].namespaceURI === 'urn:xmpp:receipts') {
            msgtype = 'received';
        } else {
            var inviteinfo = msginfo.getElementsByTagName('invite');
            if (inviteinfo && inviteinfo.length > 0) {
                msgtype = 'invite';
            }
        }
        return msgtype;
    };

    var _handleMessageQueue = function (conn) {
        for (var i in _msgHash) {
            if (_msgHash.hasOwnProperty(i)) {
                _msgHash[i].send(conn);
            }
        }
    };

    var _loginCallback = function (status, msg, conn) {
        console.log('_loginCallback', Demo.api.getObjectKey(Strophe.Status, status), msg);
        var conflict, error;

        if (msg === 'conflict') {
            conflict = true;
        }

        if (status == Strophe.Status.CONNFAIL) {
            error = {
                type: _code.WEBIM_CONNCTION_SERVER_CLOSE_ERROR
                , msg: msg
                , reconnect: true
            };

            conflict && (error.conflict = true);
            conn.onError(error);
        } else if (status == Strophe.Status.ATTACHED || status == Strophe.Status.CONNECTED) {
            var handleMessage = function (msginfo) {
                var type = _parseMessageType(msginfo);

                if ('received' === type) {
                    conn.handleReceivedMessage(msginfo);
                    return true;
                } else if ('invite' === type) {
                    conn.handleInviteMessage(msginfo);
                    return true;
                } else {
                    conn.handleMessage(msginfo);
                    return true;
                }
            };
            var handlePresence = function (msginfo) {
                conn.handlePresence(msginfo);
                return true;
            };
            var handlePing = function (msginfo) {
                conn.handlePing(msginfo);
                return true;
            };
            var handleIq = function (msginfo) {
                conn.handleIq(msginfo);
                return true;
            };

            conn.addHandler(handleMessage, null, 'message', null, null, null);
            conn.addHandler(handlePresence, null, 'presence', null, null, null);
            conn.addHandler(handlePing, 'urn:xmpp:ping', 'iq', 'get', null, null);
            conn.addHandler(handleIq, 'jabber:iq:roster', 'iq', 'set', null, null);

            conn.context.status = _code.STATUS_OPENED;

            var supportRecMessage = [
                _code.WEBIM_MESSAGE_REC_TEXT,
                _code.WEBIM_MESSAGE_REC_EMOJI];

            if (_utils.isCanDownLoadFile) {
                supportRecMessage.push(_code.WEBIM_MESSAGE_REC_PHOTO);
                supportRecMessage.push(_code.WEBIM_MESSAGE_REC_AUDIO_FILE);
            }
            var supportSedMessage = [_code.WEBIM_MESSAGE_SED_TEXT];
            if (_utils.isCanUploadFile) {
                supportSedMessage.push(_code.WEBIM_MESSAGE_REC_PHOTO);
                supportSedMessage.push(_code.WEBIM_MESSAGE_REC_AUDIO_FILE);
            }
            conn.notifyVersion();
            conn.retry && _handleMessageQueue(conn);
            conn.heartBeat();
            conn.isAutoLogin && conn.setPresence();
            conn.onOpened({
                canReceive: supportRecMessage,
                canSend: supportSedMessage,
                accessToken: conn.context.accessToken
            });
        } else if (status == Strophe.Status.DISCONNECTING) {
            if (conn.isOpened()) {
                conn.stopHeartBeat();
                conn.context.status = _code.STATUS_CLOSING;

                error = {
                    type: _code.WEBIM_CONNCTION_SERVER_CLOSE_ERROR,
                    msg: msg,
                    reconnect: true
                };

                conflict && (error.conflict = true);
                conn.onError(error);
            }
        } else if (status == Strophe.Status.DISCONNECTED) {
            conn.context.status = _code.STATUS_CLOSED;
            conn.clear();
            conn.onClosed();
        } else if (status == Strophe.Status.AUTHFAIL) {
            error = {
                type: _code.WEBIM_CONNCTION_AUTH_ERROR
            };

            conflict && (error.conflict = true);
            conn.onError(error);
            conn.clear();
        } else if (status == Strophe.Status.ERROR) {
            error = {
                type: _code.WEBIM_CONNCTION_SERVER_ERROR
            };

            conflict && (error.conflict = true);
            conn.onError(error);
        }
    };

    var _getJid = function (options, conn) {
        var jid = options.toJid || '';

        if (jid === '') {
            var appKey = conn.context.appKey || '';
            var toJid = appKey + '_' + options.to + '@' + conn.domain;

            if (options.resource) {
                toJid = toJid + '/' + options.resource;
            }
            jid = toJid;
        }
        return jid;
    };

    var _validCheck = function (options, conn) {
        options = options || {};

        if (options.user == '') {
            conn.onError({
                type: _code.WEBIM_CONNCTION_USER_NOT_ASSIGN_ERROR
            });
            return false;
        }

        var user = (options.user + '') || '';
        var appKey = options.appKey || '';
        var devInfos = appKey.split('#');

        if (devInfos.length !== 2) {
            conn.onError({
                type: _code.WEBIM_CONNCTION_APPKEY_NOT_ASSIGN_ERROR
            });
            return false;
        }
        var orgName = devInfos[0];
        var appName = devInfos[1];

        if (!orgName) {
            conn.onError({
                type: _code.WEBIM_CONNCTION_APPKEY_NOT_ASSIGN_ERROR
            });
            return false;
        }
        if (!appName) {
            conn.onError({
                type: _code.WEBIM_CONNCTION_APPKEY_NOT_ASSIGN_ERROR
            });
            return false;
        }

        var jid = appKey + '_' + user.toLowerCase() + '@' + conn.domain,
            resource = options.resource || 'webim';

        if (conn.isMultiLoginSessions) {
            resource += user + new Date().getTime() + Math.floor(Math.random().toFixed(6) * 1000000);
        }

        conn.context.jid = jid + '/' + resource;
        /*jid: {appkey}_{username}@domain/resource*/
        conn.context.userId = user;
        conn.context.appKey = appKey;
        conn.context.appName = appName;
        conn.context.orgName = orgName;

        return true;
    };

    var _getXmppUrl = function (baseUrl, https) {
        if (/^(ws|http)s?:\/\/?/.test(baseUrl)) {
            return baseUrl;
        }

        var url = {
            prefix: 'http',
            base: '://' + baseUrl,
            suffix: '/http-bind/'
        };

        if (https && _utils.isSupportWss) {
            url.prefix = 'wss';
            url.suffix = '/ws/';
        } else {
            if (https) {
                url.prefix = 'https';
            } else if (window.WebSocket) {
                url.prefix = 'ws';
                url.suffix = '/ws/';
            }
        }

        return url.prefix + url.base + url.suffix;
    };

    //class
    var connection = function (options) {
        if (!this instanceof connection) {
            return new connection(options);
        }

        var options = options || {};

        this.isMultiLoginSessions = options.isMultiLoginSessions || false;
        this.wait = options.wait || 30;
        this.retry = options.retry || false;
        this.https = options.https || location.protocol === 'https:';
        this.url = _getXmppUrl(options.url, this.https);
        this.hold = options.hold || 1;
        this.route = options.route || null;
        this.domain = options.domain || 'easemob.com';
        this.inactivity = options.inactivity || 30;
        this.heartBeatWait = options.heartBeatWait;
        this.maxRetries = options.maxRetries || 5;
        this.isAutoLogin = options.isAutoLogin === false ? false : true;
        this.pollingTime = options.pollingTime || 800;
        this.stropheConn = false;
        this.context = {status: _code.STATUS_INIT};
    };

    connection.prototype.listen = function (options) {
        options.url && (this.url = _getXmppUrl(options.url, this.https));
        this.onOpened = options.onOpened || _utils.emptyfn;
        this.onClosed = options.onClosed || _utils.emptyfn;
        this.onTextMessage = options.onTextMessage || _utils.emptyfn;
        this.onEmojiMessage = options.onEmojiMessage || _utils.emptyfn;
        this.onPictureMessage = options.onPictureMessage || _utils.emptyfn;
        this.onAudioMessage = options.onAudioMessage || _utils.emptyfn;
        this.onVideoMessage = options.onVideoMessage || _utils.emptyfn;
        this.onFileMessage = options.onFileMessage || _utils.emptyfn;
        this.onLocationMessage = options.onLocationMessage || _utils.emptyfn;
        this.onCmdMessage = options.onCmdMessage || _utils.emptyfn;
        this.onPresence = options.onPresence || _utils.emptyfn;
        this.onRoster = options.onRoster || _utils.emptyfn;
        this.onError = options.onError || _utils.emptyfn;
        this.onReceivedMessage = options.onReceivedMessage || _utils.emptyfn;
        this.onInviteMessage = options.onInviteMessage || _utils.emptyfn;
        this.onOffline = options.onOffline || _utils.emptyfn;
        this.onOnline = options.onOnline || _utils.emptyfn;
        this.onConfirmPop = options.onConfirmPop || _utils.emptyfn;
        //for WindowSDK
        this.onUpdateMyGroupList = options.onUpdateMyGroupList || _utils.emptyfn;
        this.onUpdateMyRoster = options.onUpdateMyRoster || _utils.emptyfn;


        _listenNetwork(this.onOnline, this.onOffline);
    };

    connection.prototype.heartBeat = function () {
        var me = this;
        //IE8: strophe auto switch from ws to BOSH, need heartbeat
        var isNeed = !/^ws|wss/.test(me.url) || /mobile/.test(navigator.userAgent);

        if (this.heartBeatID || !isNeed) {
            return;
        }

        var options = {
            to: this.domain,
            type: 'normal'
        };
        this.heartBeatID = setInterval(function () {
            me.sendHeartBeatMessage(options);
        }, this.heartBeatWait);
    };

    connection.prototype.sendHeartBeatMessage = function (options) {
        if (!this.isOpened()) {
            return;
        }

        var json = {},
            jsonstr = _utils.stringify(json),
            dom = $msg({
                to: options.to,
                type: options.type,
                id: this.getUniqueId(),
                xmlns: 'jabber:client'
            }).c('body').t(jsonstr);

        this.sendCommand(dom.tree());
    };

    connection.prototype.stopHeartBeat = function () {
        if (typeof this.heartBeatID == "number") {
            this.heartBeatID = clearInterval(this.heartBeatID);
        }
    };


    connection.prototype.sendReceiptsMessage = function (options) {
        var dom = $msg({
            from: this.context.jid || '',
            to: this.domain,
            id: options.id || ''
        }).c('received', {
            xmlns: 'urn:xmpp:receipts',
            id: options.id || ''
        });
        this.sendCommand(dom.tree());
    };

    connection.prototype.open = function (options) {

        var pass = _validCheck(options, this);

        if (!pass) {
            return;
        }

        var conn = this;

        if (conn.isOpening() || conn.isOpened()) {
            return;
        }

        if (options.accessToken) {
            options.access_token = options.accessToken;
            _login(options, conn);
        } else {
            var apiUrl = options.apiUrl;
            var userId = this.context.userId;
            var pwd = options.pwd || '';
            var appName = this.context.appName;
            var orgName = this.context.orgName;

            var suc = function (data, xhr) {
                conn.context.status = _code.STATUS_DOLOGIN_IM;
                _login(data, conn);
            };
            var error = function (res, xhr, msg) {
                conn.clear();

                if (res.error && res.error_description) {
                    conn.onError({
                        type: _code.WEBIM_CONNCTION_OPEN_USERGRID_ERROR,
                        data: res,
                        xhr: xhr
                    });
                } else {
                    conn.onError({
                        type: _code.WEBIM_CONNCTION_OPEN_ERROR,
                        data: res,
                        xhr: xhr
                    });
                }
            };

            this.context.status = _code.STATUS_DOLOGIN_USERGRID;

            var loginJson = {
                grant_type: 'password',
                username: userId,
                password: pwd
            };
            var loginfo = _utils.stringify(loginJson);

            var options = {
                url: apiUrl + '/' + orgName + '/' + appName + '/token',
                dataType: 'json',
                data: loginfo,
                success: suc || _utils.emptyfn,
                error: error || _utils.emptyfn
            };
            _utils.ajax(options);
        }


    };

    // attach to xmpp server for BOSH
    connection.prototype.attach = function (options) {
        var pass = _validCheck(options, this);

        if (!pass) {
            return;
        }

        options = options || {};

        var accessToken = options.accessToken || '';
        if (accessToken == '') {
            this.onError({
                type: _code.WEBIM_CONNCTION_TOKEN_NOT_ASSIGN_ERROR
            });
            return;
        }

        var sid = options.sid || '';
        if (sid === '') {
            this.onError({
                type: _code.WEBIM_CONNCTION_SESSIONID_NOT_ASSIGN_ERROR
            });
            return;
        }

        var rid = options.rid || '';
        if (rid === '') {
            this.onError({
                type: _code.WEBIM_CONNCTION_RID_NOT_ASSIGN_ERROR
            });
            return;
        }

        var stropheConn = new Strophe.Connection(this.url, {
            inactivity: this.inactivity,
            maxRetries: this.maxRetries,
            pollingTime: this.pollingTime,
            heartBeatWait: this.heartBeatWait
        });

        this.context.accessToken = accessToken;
        this.context.stropheConn = stropheConn;
        this.context.status = _code.STATUS_DOLOGIN_IM;

        var conn = this;
        var callback = function (status, msg) {
            _loginCallback(status, msg, conn);
        };

        var jid = this.context.jid;
        var wait = this.wait;
        var hold = this.hold;
        var wind = this.wind || 5;
        stropheConn.attach(jid, sid, rid, callback, wait, hold, wind);
    };

    connection.prototype.close = function () {
        this.stopHeartBeat();

        var status = this.context.status;
        if (status == _code.STATUS_INIT) {
            return;
        }

        if (this.isClosed() || this.isClosing()) {
            return;
        }

        this.context.status = _code.STATUS_CLOSING;
        this.context.stropheConn.disconnect();
    };

    connection.prototype.addHandler = function (handler, ns, name, type, id, from, options) {
        this.context.stropheConn.addHandler(handler, ns, name, type, id, from, options);
    };

    connection.prototype.notifyVersion = function (suc, fail) {
        var jid = _getJid({}, this);
        var dom = $iq({
            from: this.context.jid || ''
            , to: this.domain
            , type: 'result'
        })
            .c('query', {xmlns: 'jabber:iq:version'})
            .c('name')
            .t('easemob')
            .up()
            .c('version')
            .t(_version)
            .up()
            .c('os')
            .t('webim');

        var suc = suc || _utils.emptyfn;
        var error = fail || this.onError;
        var failFn = function (ele) {
            error({
                type: _code.WEBIM_CONNCTION_NOTIFYVERSION_ERROR
                , data: ele
            });
        };
        this.context.stropheConn.sendIQ(dom.tree(), suc, failFn);
        return;
    };

    // handle all types of presence message
    connection.prototype.handlePresence = function (msginfo) {
        if (this.isClosed()) {
            return;
        }
        var from = msginfo.getAttribute('from') || '';
        var to = msginfo.getAttribute('to') || '';
        var type = msginfo.getAttribute('type') || '';
        var presence_type = msginfo.getAttribute('presence_type') || '';
        var fromUser = _parseNameFromJidFn(from);
        var toUser = _parseNameFromJidFn(to);
        var info = {
            from: fromUser,
            to: toUser,
            fromJid: from,
            toJid: to,
            type: type,
            chatroom: msginfo.getElementsByTagName('roomtype').length ? true : false
        };


        var showTags = msginfo.getElementsByTagName('show');
        if (showTags && showTags.length > 0) {
            var showTag = showTags[0];
            info.show = Strophe.getText(showTag);
        }
        var statusTags = msginfo.getElementsByTagName('status');
        if (statusTags && statusTags.length > 0) {
            var statusTag = statusTags[0];
            info.status = Strophe.getText(statusTag);
            info.code = statusTag.getAttribute('code');
        }

        var priorityTags = msginfo.getElementsByTagName('priority');
        if (priorityTags && priorityTags.length > 0) {
            var priorityTag = priorityTags[0];
            info.priority = Strophe.getText(priorityTag);
        }

        var error = msginfo.getElementsByTagName('error');
        if (error && error.length > 0) {
            var error = error[0];
            info.error = {
                code: error.getAttribute('code')
            };
        }

        var destroy = msginfo.getElementsByTagName('destroy');
        if (destroy && destroy.length > 0) {
            var destroy = destroy[0];
            info.destroy = true;

            var reason = destroy.getElementsByTagName('reason');
            if (reason && reason.length > 0) {
                info.reason = Strophe.getText(reason[0]);
            }
        }

        if (info.chatroom) {
            var reflectUser = from.slice(from.lastIndexOf('/') + 1);

            if (reflectUser === this.context.userId) {
                if (info.type === '' && !info.code) {
                    info.type = 'joinChatRoomSuccess';
                } else if (presence_type === 'unavailable' || info.type === 'unavailable') {
                    if (!info.status) {// logout successfully.
                        info.type = 'leaveChatRoom';
                    } else if (info.code == 110) {// logout or dismissied by admin.
                        info.type = 'leaveChatRoom';
                    } else if (info.error && info.error.code == 406) {// The chat room is full.
                        info.type = 'reachChatRoomCapacity';
                    }
                }
            }
        } else {
            if (type == "" && !info.status && !info.error) {
                info.type = 'joinPublicGroupSuccess';
            } else if (presence_type === 'unavailable' || type === 'unavailable') {// There is no roomtype when a chat room is deleted.
                if (info.destroy) {// Group or Chat room Deleted.
                    info.type = 'deleteGroupChat';
                } else if (info.code == 307 || info.code == 321) {// Dismissed by group.
                    info.type = 'leaveGroup';
                }
            }
        }
        this.onPresence(info, msginfo);
    };

    connection.prototype.handlePing = function (e) {
        if (this.isClosed()) {
            return;
        }
        var id = e.getAttribute('id');
        var from = e.getAttribute('from');
        var to = e.getAttribute('to');
        var dom = $iq({
            from: to
            , to: from
            , id: id
            , type: 'result'
        });
        this.sendCommand(dom.tree());
    };

    connection.prototype.handleIq = function (e) {
        var id = e.getAttribute('id');
        var from = e.getAttribute('from') || '';
        var name = _parseNameFromJidFn(from);
        var curJid = this.context.jid;
        var curUser = this.context.userId;

        var iqresult = $iq({type: 'result', id: id, from: curJid});
        this.sendCommand(iqresult.tree());

        var msgBodies = e.getElementsByTagName('query');
        if (msgBodies && msgBodies.length > 0) {
            var queryTag = msgBodies[0];
            var rouster = _parseFriend(queryTag);
            this.onRoster(rouster);
        }
        return true;
    };

    connection.prototype.handleMessage = function (msginfo) {
        if (this.isClosed()) {
            return;
        }

        var id = msginfo.getAttribute('id') || '';

        // send ack
        this.sendReceiptsMessage({
            id: id
        });
        var parseMsgData = _parseResponseMessage(msginfo);
        if (parseMsgData.errorMsg) {
            this.handlePresence(msginfo);
            return;
        }
        var msgDatas = parseMsgData.data;
        for (var i in msgDatas) {
            if (!msgDatas.hasOwnProperty(i)) {
                continue;
            }
            var msg = msgDatas[i];
            if (!msg.from || !msg.to) {
                continue;
            }

            var from = (msg.from + '').toLowerCase();
            var too = (msg.to + '').toLowerCase();
            var extmsg = msg.ext || {};
            var chattype = '';
            var typeEl = msginfo.getElementsByTagName('roomtype');
            if (typeEl.length) {
                chattype = typeEl[0].getAttribute('type') || 'chat';
            } else {
                chattype = msginfo.getAttribute('type') || 'chat';
            }

            var msgBodies = msg.bodies;
            if (!msgBodies || msgBodies.length == 0) {
                continue;
            }
            var msgBody = msg.bodies[0];
            var type = msgBody.type;

            try {
                switch (type) {
                    case 'txt':
                        var receiveMsg = msgBody.msg;
                        var emojibody = _utils.parseTextMessage(receiveMsg, WebIM.Emoji);
                        if (emojibody.isemoji) {
                            var msg = {
                                id: id
                                , type: chattype
                                , from: from
                                , to: too
                                , delay: parseMsgData.delayTimeStamp
                                , data: emojibody.body
                                , ext: extmsg
                            };
                            !msg.delay && delete msg.delay;
                            this.onEmojiMessage(msg);
                        } else {
                            var msg = {
                                id: id
                                , type: chattype
                                , from: from
                                , to: too
                                , delay: parseMsgData.delayTimeStamp
                                , data: receiveMsg
                                , ext: extmsg
                            };
                            !msg.delay && delete msg.delay;
                            this.onTextMessage(msg);
                        }
                        break;
                    case 'img':
                        var rwidth = 0;
                        var rheight = 0;
                        if (msgBody.size) {
                            rwidth = msgBody.size.width;
                            rheight = msgBody.size.height;
                        }
                        var msg = {
                            id: id
                            , type: chattype
                            , from: from
                            , to: too
                            , url: msgBody.url
                            , secret: msgBody.secret
                            , filename: msgBody.filename
                            , thumb: msgBody.thumb
                            , thumb_secret: msgBody.thumb_secret
                            , file_length: msgBody.file_length || ''
                            , width: rwidth
                            , height: rheight
                            , filetype: msgBody.filetype || ''
                            , accessToken: this.context.accessToken || ''
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.delay;
                        this.onPictureMessage(msg);
                        break;
                    case 'audio':
                        var msg = {
                            id: id
                            , type: chattype
                            , from: from
                            , to: too
                            , url: msgBody.url
                            , secret: msgBody.secret
                            , filename: msgBody.filename
                            , length: msgBody.length || ''
                            , file_length: msgBody.file_length || ''
                            , filetype: msgBody.filetype || ''
                            , accessToken: this.context.accessToken || ''
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.delay;
                        this.onAudioMessage(msg);
                        break;
                    case 'file':
                        var msg = {
                            id: id
                            , type: chattype
                            , from: from
                            , to: too
                            , url: msgBody.url
                            , secret: msgBody.secret
                            , filename: msgBody.filename
                            , file_length: msgBody.file_length
                            , accessToken: this.context.accessToken || ''
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.delay;
                        this.onFileMessage(msg);
                        break;
                    case 'loc':
                        var msg = {
                            id: id
                            , type: chattype
                            , from: from
                            , to: too
                            , addr: msgBody.addr
                            , lat: msgBody.lat
                            , lng: msgBody.lng
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.dealy;
                        this.onLocationMessage(msg);
                        break;
                    case 'video':
                        var msg = {
                            id: id
                            , type: chattype
                            , from: from
                            , to: too
                            , url: msgBody.url
                            , secret: msgBody.secret
                            , filename: msgBody.filename
                            , file_length: msgBody.file_length
                            , accessToken: this.context.accessToken || ''
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.dealy;
                        this.onVideoMessage(msg);
                        break;
                    case 'cmd':
                        var msg = {
                            id: id
                            , from: from
                            , to: too
                            , action: msgBody.action
                            , ext: extmsg
                            , delay: parseMsgData.delayTimeStamp
                        };
                        !msg.delay && delete msg.dealy;
                        this.onCmdMessage(msg);
                        break;
                }
                ;
            } catch (e) {
                this.onError({
                    type: _code.WEBIM_CONNCTION_CALLBACK_INNER_ERROR
                    , data: e
                });
            }
        }
    };

    connection.prototype.handleReceivedMessage = function (message) {
        try {
            this.onReceivedMessage(message);
        } catch (e) {
            this.onError({
                type: _code.WEBIM_CONNCTION_CALLBACK_INNER_ERROR
                , data: e
            });
        }

        var rcv = message.getElementsByTagName('received'),
            id,
            mid;

        if (rcv.length > 0) {
            if (rcv[0].childNodes && rcv[0].childNodes.length > 0) {
                id = rcv[0].childNodes[0].nodeValue;
            } else {
                id = rcv[0].innerHTML || rcv[0].innerText;
            }
            mid = rcv[0].getAttribute('mid');
        }

        if (_msgHash[id]) {
            try {
                _msgHash[id].msg.success instanceof Function && _msgHash[id].msg.success(id, mid);
            } catch (e) {
                this.onError({
                    type: _code.WEBIM_CONNCTION_CALLBACK_INNER_ERROR
                    , data: e
                });
            }
            delete _msgHash[id];
        }
    };

    connection.prototype.handleInviteMessage = function (message) {
        var form = null;
        var invitemsg = message.getElementsByTagName('invite');
        var id = message.getAttribute('id') || '';
        this.sendReceiptsMessage({
            id: id
        });

        if (invitemsg && invitemsg.length > 0) {
            var fromJid = invitemsg[0].getAttribute('from');
            form = _parseNameFromJidFn(fromJid);
        }
        var xmsg = message.getElementsByTagName('x');
        var roomid = null;
        if (xmsg && xmsg.length > 0) {
            for (var i = 0; i < xmsg.length; i++) {
                if ('jabber:x:conference' === xmsg[i].namespaceURI) {
                    var roomjid = xmsg[i].getAttribute('jid');
                    roomid = _parseNameFromJidFn(roomjid);
                }
            }
        }
        this.onInviteMessage({
            type: 'invite',
            from: form,
            roomid: roomid
        });
    };

    connection.prototype.sendCommand = function (dom, id) {
        if (this.isOpened()) {
            this.context.stropheConn.send(dom);
        } else {
            this.onError({
                type: _code.WEBIM_CONNCTION_DISCONNECTED,
                reconnect: true
            });
        }
    };

    connection.prototype.getUniqueId = function (prefix) {
        var cdate = new Date();
        var offdate = new Date(2010, 1, 1);
        var offset = cdate.getTime() - offdate.getTime();
        var hexd = parseInt(offset).toString(16);

        if (typeof prefix === 'string' || typeof prefix === 'number') {
            return prefix + '_' + hexd;
        } else {
            return 'WEBIM_' + hexd;
        }
    };

    connection.prototype.send = function (message) {
        if (WebIM.config.isWindowSDK) {
            WebIM.doQuery('{"type":"sendMessage","to":"' + message.to + '","message_type":"' + message.type + '","msg":"' + encodeURI(message.msg) + '","chatType":"' + message.chatType + '"}',
                function (response) {
                },
                function (code, msg) {
                    Demo.api.NotifyError('send:' + code + " - " + msg);
                });
        } else {
            if (Object.prototype.toString.call(message) === '[object Object]') {
                var appKey = this.context.appKey || '';
                var toJid = appKey + '_' + message.to + '@' + this.domain;

                if (message.group) {
                    toJid = appKey + '_' + message.to + '@conference.' + this.domain;
                }
                if (message.resource) {
                    toJid = toJid + '/' + message.resource;
                }

                message.toJid = toJid;
                message.id = message.id || this.getUniqueId();
                _msgHash[message.id] = new _message(message);
                _msgHash[message.id].send(this);
            } else if (typeof message === 'string') {
                _msgHash[message] && _msgHash[message].send(this);
            }
        }
    };

    connection.prototype.addRoster = function (options) {
        var jid = _getJid(options, this);
        var name = options.name || '';
        var groups = options.groups || '';

        var iq = $iq({type: 'set'});
        iq.c('query', {xmlns: 'jabber:iq:roster'});
        iq.c('item', {jid: jid, name: name});

        if (groups) {
            for (var i = 0; i < groups.length; i++) {
                iq.c('group').t(groups[i]).up();
            }
        }
        var suc = options.success || _utils.emptyfn;
        var error = options.error || _utils.emptyfn;
        this.context.stropheConn.sendIQ(iq.tree(), suc, error);
    };

    connection.prototype.removeRoster = function (options) {
        var jid = _getJid(options, this);
        var iq = $iq({type: 'set'}).c('query', {xmlns: 'jabber:iq:roster'}).c('item', {
            jid: jid,
            subscription: 'remove'
        });

        var suc = options.success || _utils.emptyfn;
        var error = options.error || _utils.emptyfn;
        this.context.stropheConn.sendIQ(iq, suc, error);
    };

    connection.prototype.getRoster = function (options) {
        var conn = this;
        var dom = $iq({
            type: 'get'
        }).c('query', {xmlns: 'jabber:iq:roster'});

        var options = options || {};
        var suc = options.success || this.onRoster;
        var completeFn = function (ele) {
            var rouster = [];
            var msgBodies = ele.getElementsByTagName('query');
            if (msgBodies && msgBodies.length > 0) {
                var queryTag = msgBodies[0];
                rouster = _parseFriend(queryTag);
            }
            suc(rouster, ele);
        };
        var error = options.error || this.onError;
        var failFn = function (ele) {
            error({
                type: _code.WEBIM_CONNCTION_GETROSTER_ERROR
                , data: ele
            });
        };
        if (this.isOpened()) {
            this.context.stropheConn.sendIQ(dom.tree(), completeFn, failFn);
        } else {
            error({
                type: _code.WEBIM_CONNCTION_DISCONNECTED
            });
        }
    };

    connection.prototype.subscribe = function (options) {
        var jid = _getJid(options, this);
        var pres = $pres({to: jid, type: 'subscribe'});
        if (options.message) {
            pres.c('status').t(options.message).up();
        }
        if (options.nick) {
            pres.c('nick', {'xmlns': 'http://jabber.org/protocol/nick'}).t(options.nick);
        }
        this.sendCommand(pres.tree());
    };

    connection.prototype.subscribed = function (options) {
        var jid = _getJid(options, this);
        var pres = $pres({to: jid, type: 'subscribed'});

        if (options.message) {
            pres.c('status').t(options.message).up();
        }
        this.sendCommand(pres.tree());
    };

    connection.prototype.unsubscribe = function (options) {
        var jid = _getJid(options, this);
        var pres = $pres({to: jid, type: 'unsubscribe'});

        if (options.message) {
            pres.c('status').t(options.message);
        }
        this.sendCommand(pres.tree());
    };

    connection.prototype.unsubscribed = function (options) {
        var jid = _getJid(options, this);
        var pres = $pres({to: jid, type: 'unsubscribed'});

        if (options.message) {
            pres.c('status').t(options.message).up();
        }
        this.sendCommand(pres.tree());
    };

    connection.prototype.createRoom = function (options) {
        var suc = options.success || _utils.emptyfn;
        var err = options.error || _utils.emptyfn;
        var roomiq;

        roomiq = $iq({
            to: options.roomName,
            type: 'set'
        })
            .c('query', {xmlns: Strophe.NS.MUC_OWNER})
            .c('x', {xmlns: 'jabber:x:data', type: 'submit'});

        return this.context.stropheConn.sendIQ(roomiq.tree(), suc, err);
    };

    connection.prototype.joinPublicGroup = function (options) {
        var roomJid = this.context.appKey + '_' + options.roomId + '@conference.' + this.domain;
        var room_nick = roomJid + '/' + this.context.userId;
        var suc = options.success || _utils.emptyfn;
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_JOINROOM_ERROR,
                data: ele
            });
        };
        var iq = $pres({
            from: this.context.jid,
            to: room_nick
        })
            .c('x', {xmlns: Strophe.NS.MUC});

        this.context.stropheConn.sendIQ(iq.tree(), suc, errorFn);
    };

    connection.prototype.listRooms = function (options) {
        var iq = $iq({
            to: options.server || 'conference.' + this.domain,
            from: this.context.jid,
            type: 'get'
        })
            .c('query', {xmlns: Strophe.NS.DISCO_ITEMS});

        var suc = options.success || _utils.emptyfn;
        var error = options.error || this.onError;
        var completeFn = function (result) {
            var rooms = [];
            rooms = _parseRoom(result);
            try {
                suc(rooms);
            } catch (e) {
                error({
                    type: _code.WEBIM_CONNCTION_GETROOM_ERROR,
                    data: e
                });
            }
        };
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_GETROOM_ERROR
                , data: ele
            });
        };
        this.context.stropheConn.sendIQ(iq.tree(), completeFn, errorFn);
    };

    connection.prototype.queryRoomMember = function (options) {
        var domain = this.domain;
        var members = [];
        var iq = $iq({
            to: this.context.appKey + '_' + options.roomId + '@conference.' + this.domain
            , type: 'get'
        })
            .c('query', {xmlns: Strophe.NS.MUC + '#admin'})
            .c('item', {affiliation: 'member'});

        var suc = options.success || _utils.emptyfn;
        var completeFn = function (result) {
            var items = result.getElementsByTagName('item');

            if (items) {
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    var mem = {
                        jid: item.getAttribute('jid')
                        , affiliation: 'member'
                    };
                    members.push(mem);
                }
            }
            suc(members);
        };
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_GETROOMMEMBER_ERROR
                , data: ele
            });
        };
        this.context.stropheConn.sendIQ(iq.tree(), completeFn, errorFn);
    };

    connection.prototype.queryRoomInfo = function (options) {
        var domain = this.domain;
        var iq = $iq({
            to: this.context.appKey + '_' + options.roomId + '@conference.' + domain,
            type: 'get'
        }).c('query', {xmlns: Strophe.NS.DISCO_INFO});

        var suc = options.success || _utils.emptyfn;
        var members = [];
        var completeFn = function (result) {
            var fields = result.getElementsByTagName('field');
            if (fields) {
                for (var i = 0; i < fields.length; i++) {
                    var field = fields[i];
                    if (field.getAttribute('label') === 'owner') {
                        var mem = {
                            jid: (field.textContent || field.text) + '@' + domain
                            , affiliation: 'owner'
                        };
                        members.push(mem);
                    }
                }
            }
            suc(members);
        };
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_GETROOMINFO_ERROR
                , data: ele
            });
        };
        this.context.stropheConn.sendIQ(iq.tree(), completeFn, errorFn);
    };

    connection.prototype.queryRoomOccupants = function (options) {
        var suc = options.success || _utils.emptyfn;
        var completeFn = function (result) {
            var occupants = [];
            occupants = _parseRoomOccupants(result);
            suc(occupants);
        }
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_GETROOMOCCUPANTS_ERROR
                , data: ele
            });
        };
        var attrs = {
            xmlns: Strophe.NS.DISCO_ITEMS
        };
        var info = $iq({
            from: this.context.jid
            , to: this.context.appKey + '_' + options.roomId + '@conference.' + this.domain
            , type: 'get'
        }).c('query', attrs);
        this.context.stropheConn.sendIQ(info.tree(), completeFn, errorFn);
    };

    connection.prototype.setUserSig = function (desc) {
        var dom = $pres({xmlns: 'jabber:client'});
        desc = desc || '';
        dom.c('status').t(desc);
        this.sendCommand(dom.tree());
    };

    connection.prototype.setPresence = function (type, status) {
        var dom = $pres({xmlns: 'jabber:client'});
        if (type) {
            if (status) {
                dom.c('show').t(type);
                dom.up().c('status').t(status);
            } else {
                dom.c('show').t(type);
            }
        }
        this.sendCommand(dom.tree());
    };

    connection.prototype.getPresence = function () {
        var dom = $pres({xmlns: 'jabber:client'});
        var conn = this;
        this.sendCommand(dom.tree());
    };

    connection.prototype.ping = function (options) {
        var options = options || {};
        var jid = _getJid(options, this);

        var dom = $iq({
            from: this.context.jid || ''
            , to: jid
            , type: 'get'
        }).c('ping', {xmlns: 'urn:xmpp:ping'});

        var suc = options.success || _utils.emptyfn;
        var error = options.error || this.onError;
        var failFn = function (ele) {
            error({
                type: _code.WEBIM_CONNCTION_PING_ERROR
                , data: ele
            });
        };
        if (this.isOpened()) {
            this.context.stropheConn.sendIQ(dom.tree(), suc, failFn);
        } else {
            error({
                type: _code.WEBIM_CONNCTION_DISCONNECTED
            });
        }
        return;
    };

    connection.prototype.isOpened = function () {
        return this.context.status == _code.STATUS_OPENED;
    };

    connection.prototype.isOpening = function () {
        var status = this.context.status;
        return status == _code.STATUS_DOLOGIN_USERGRID || status == _code.STATUS_DOLOGIN_IM;
    };

    connection.prototype.isClosing = function () {
        return this.context.status == _code.STATUS_CLOSING;
    };

    connection.prototype.isClosed = function () {
        return this.context.status == _code.STATUS_CLOSED;
    };

    connection.prototype.clear = function () {
        var key = this.context.appKey;
        this.context = {
            status: _code.STATUS_INIT
            , appKey: key
        };
    };

    connection.prototype.getChatRooms = function (options) {

        if (!_utils.isCanSetRequestHeader) {
            conn.onError({
                type: _code.WEBIM_CONNCTION_NOT_SUPPORT_CHATROOM_ERROR
            });
            return;
        }

        var conn = this,
            token = options.accessToken || this.context.accessToken;

        if (token) {
            var apiUrl = options.apiUrl;
            var appName = this.context.appName;
            var orgName = this.context.orgName;

            if (!appName || !orgName) {
                conn.onError({
                    type: _code.WEBIM_CONNCTION_AUTH_ERROR
                });
                return;
            }

            var suc = function (data, xhr) {
                typeof options.success === 'function' && options.success(data);
            };

            var error = function (res, xhr, msg) {
                if (res.error && res.error_description) {
                    conn.onError({
                        type: _code.WEBIM_CONNCTION_LOAD_CHATROOM_ERROR,
                        msg: res.error_description,
                        data: res,
                        xhr: xhr
                    });
                }
            };

            var opts = {
                url: apiUrl + '/' + orgName + '/' + appName + '/chatrooms',
                dataType: 'json',
                type: 'GET',
                headers: {'Authorization': 'Bearer ' + token},
                success: suc || _utils.emptyfn,
                error: error || _utils.emptyfn
            };
            // console.log(opts);
            _utils.ajax(opts);
        } else {
            conn.onError({
                type: _code.WEBIM_CONNCTION_TOKEN_NOT_ASSIGN_ERROR
            });
        }

    };

    connection.prototype.joinChatRoom = function (options) {
        var roomJid = this.context.appKey + '_' + options.roomId + '@conference.' + this.domain;
        var room_nick = roomJid + '/' + this.context.userId;
        var suc = options.success || _utils.emptyfn;
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_JOINCHATROOM_ERROR
                , data: ele
            });
        };

        var iq = $pres({
            from: this.context.jid,
            to: room_nick
        })
            .c('x', {xmlns: Strophe.NS.MUC + '#user'})
            .c('item', {affiliation: 'member', role: 'participant'})
            .up().up()
            .c('roomtype', {xmlns: 'easemob:x:roomtype', type: 'chatroom'});

        this.context.stropheConn.sendIQ(iq.tree(), suc, errorFn);
    };

    connection.prototype.quitChatRoom = function (options) {
        var roomJid = this.context.appKey + '_' + options.roomId + '@conference.' + this.domain;
        var room_nick = roomJid + '/' + this.context.userId;
        var suc = options.success || _utils.emptyfn;
        var err = options.error || _utils.emptyfn;
        var errorFn = function (ele) {
            err({
                type: _code.WEBIM_CONNCTION_QUITCHATROOM_ERROR
                , data: ele
            });
        };
        var iq = $pres({
            from: this.context.jid,
            to: room_nick,
            type: 'unavailable'
        })
            .c('x', {xmlns: Strophe.NS.MUC + '#user'})
            .c('item', {affiliation: 'none', role: 'none'})
            .up().up()
            .c('roomtype', {xmlns: 'easemob:x:roomtype', type: 'chatroom'});

        this.context.stropheConn.sendIQ(iq.tree(), suc, errorFn);
    };

    connection.prototype._onReceiveInviteFromGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group invitation",
            msg: info.user + " invites you to join into group:" + info.group_id,
            agree: function agree() {
                WebIM.doQuery('{"type":"acceptInvitationFromGroup","id":"' + info.group_id + '","user":"' + info.user + '"}', function (response) {
                }, function (code, msg) {
                    Demo.api.NotifyError("acceptInvitationFromGroup error:" + msg);
                });

            },
            reject: function reject() {
                WebIM.doQuery('{"type":"declineInvitationFromGroup","id":"' + info.group_id + '","user":"' + info.user + '"}', function (response) {
                }, function (code, msg) {
                    Demo.api.NotifyError("declineInvitationFromGroup error:" + msg);
                });
            }
        };

        this.onConfirmPop(options);
    };
    connection.prototype._onReceiveInviteAcceptionFromGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group invitation response",
            msg: info.user + " agreed to join into group:" + info.group_id,
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onReceiveInviteDeclineFromGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group invitation response",
            msg: info.user + " rejected to join into group:" + info.group_id,
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onAutoAcceptInvitationFromGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group invitation",
            msg: "You had joined into the group:" + info.group_name + " automatically.Inviter:" + info.user,
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onLeaveGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group notification",
            msg: "You have been out of the group:" + info.group_id + ".Reason:" + info.msg,
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onReceiveJoinGroupApplication = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group join application",
            msg: info.user + " applys to join into group:" + info.group_id,
            agree: function agree() {
                WebIM.doQuery('{"type":"acceptJoinGroupApplication","id":"' + info.group_id + '","user":"' + info.user + '"}', function (response) {
                }, function (code, msg) {
                    Demo.api.NotifyError("acceptJoinGroupApplication error:" + msg);
                });
            },
            reject: function reject() {
                WebIM.doQuery('{"type":"declineJoinGroupApplication","id":"' + info.group_id + '","user":"' + info.user + '"}', function (response) {
                }, function (code, msg) {
                    Demo.api.NotifyError("declineJoinGroupApplication error:" + msg);
                });
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onReceiveAcceptionFromGroup = function (info) {
        info = eval('(' + info + ')');
        var options = {
            title: "Group notification",
            msg: "You had joined into the group:" + info.group_name + ".",
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onReceiveRejectionFromGroup = function () {
        info = eval('(' + info + ')');
        var options = {
            title: "Group notification",
            msg: "You have been rejected to join into the group:" + info.group_name + ".",
            agree: function agree() {
            }
        };
        this.onConfirmPop(options);
    };
    connection.prototype._onUpdateMyGroupList = function (options) {
        this.onUpdateMyGroupList(options);
    };
    connection.prototype._onUpdateMyRoster = function (options) {
        this.onUpdateMyRoster(options);
    };

    window.WebIM = typeof WebIM !== 'undefined' ? WebIM : {};
    WebIM.connection = connection;
    WebIM.utils = _utils;
    WebIM.statusCode = _code;
    WebIM.message = _msg.message;
    WebIM.doQuery = function (str, suc, fail) {
        if (typeof window.cefQuery === 'undefined') {
            return;
        }
        window.cefQuery({
                request: str,
                persistent: false,
                onSuccess: suc,
                onFailure: fail
            }
        );
    };
}(window, undefined));
