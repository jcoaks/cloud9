/**
 * Java Runtime Module for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
var Path = require("path");
var Plugin = require("../cloud9.core/plugin");
var util = require("util");

var name = "jvm-runtime";
var ProcessManager;
var EventBus;

module.exports = function setup(options, imports, register) {
    ProcessManager = imports["process-manager"];
    EventBus = imports.eventbus;
    imports.ide.register(name, JVMRuntimePlugin, register);
};

var JVMRuntimePlugin = function(ide, workspace) {
    Plugin.call(this, ide, workspace);

    this.pm = ProcessManager;
    this.eventbus = EventBus;
    this.workspaceId = workspace.workspaceId;
    this.channel = this.workspaceId + "::" + name;
    this.hooks = ["command"];
    this.name = name;
    this.processCount = 0;
};

util.inherits(JVMRuntimePlugin, Plugin);

(function() {

    this.init = function() {
        var self = this;
        this.eventbus.on(this.channel, function(msg) {
            msg.type = msg.type.replace(/^node-debug-(start|data|exit)$/, "node-$1");
            var type = msg.type;

            if (type == "node-start" || type == "node-exit")
                self.workspace.getExt("state").publishState();

            if (msg.type == "node-start")
                self.processCount += 1;

            if (msg.type == "node-exit")
                self.processCount -= 1;

            // For compatability with node running messages
            // TODO: refactor console.js & other dependant parts
            // msg.type = msg.type.replace(/^jvm-/, "node-");
            self.ide.broadcast(JSON.stringify(msg), self.name);
        });
    };

    this.command = function(user, message, client) {
        var cmd = (message.command || "").toLowerCase();
        if (!(/^(java|java-web|gae-java|jpy|jrb|groovy|js-rhino)$/.test(message.runner)))
          return false;

        var res = true;
        switch (cmd) {
            case "run":
                this.$run(message.file, message.args || [], message.env || {}, message.version, message, client);
                break;
            case "rundebug":
                this.$debug(message.file, message.args || [], message.env || {}, false, message.version, message, client);
                break;
            case "rundebugbrk":
                this.$debug(message.file, message.args || [], message.env || {}, true, message.version, message, client);
                break;
            case "kill":
                this.$kill(message.pid, message, client);
                break;
            case "debugnode":
                this.pm.debug(message.pid, message.body, function(err) {
                    if (err) console.error(err);
                });
                break;
            default:
                res = false;
        }
        return res;
    };

    this.$run = function(file, args, env, version, message, client) {
        var self = this;
        this.workspace.getExt("state").getState(function(err, state) {
            if (err)
                return self.error(err, 1, message, client);

            if (state.processRunning)
                return self.error("Child process already running!", 1, message);

            self.$buildProject(function buildSuccess() {
                self.pm.spawn("jvm", {
                    file: file,
                    args: args,
                    env: env,
                    jvmType: message.runner,
                    version: version,
                    extra: message.extra
                }, self.channel, function(err, pid, child) {
                    if (err)
                        self.error(err, 1, message, client);
                });
            });
        });
    };

    this.$debug = function(file, args, env, breakOnStart, version, message, client) {
        var self = this;
        this.workspace.getExt("state").getState(function(err, state) {
            if (err)
                return self.error(err, 1, message, client);

            if (state.processRunning)
                return self.error("Child process already running!", 1, message);

            self.$buildProject(function buildSuccess() {
                self.pm.spawn("jvm-debug", {
                    file: file,
                    args: args,
                    env: env,
                    breakOnStart: breakOnStart,
                    jvmType: message.runner,
                    version: version,
                    extra: message.extra
                }, self.channel, function(err, pid, child) {
                    if (err)
                        self.error(err, 1, message, client);
                });
            });
        });
    };

    this.$buildProject = function(buildSuccess) {
        var self = this;

        var buildCompleteChannel = this.workspaceId + "::jvm-build-complete";
        this.eventbus.on(buildCompleteChannel, function buildComplete(data) {
            self.eventbus.removeListener(buildCompleteChannel, buildComplete);

            var problems = data.body;
            // If no errors found, we can start
            var numErrors = problems.filter(function (problem) {
                return problem.type == "error"; }).length;
            if (numErrors > 0) {
                console.log("Found " + numErrors + " compilation errors !");
                self.sendResult(0, "buildproject", data);
            } else {
                buildSuccess();
            }
        });

        self.eventbus.emit(this.workspaceId + "::jvm-build", {
            channel: buildCompleteChannel
        });
    };

    this.$kill = function(pid, message, client) {
        this.pm.kill(pid, function(err) {
            if (err)
                return this.error(err, 1, message, client);
        });
    };

    this.canShutdown = function() {
        return this.processCount === 0;
    };

}).call(JVMRuntimePlugin.prototype);
