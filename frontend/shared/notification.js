// Notification System (Alertify-based, customized for Linkify)
(function (global, undefined) {
  "use strict";
  var document = global.document,
      Notification;

  Notification = function () {
    var _notification = {},
        isopen    = false,
        queue     = [],
        $, elLog, getTransitionEvent;

    /**
     * Return the proper transitionend event
     */
    getTransitionEvent = function () {
      var t,
          type,
          supported   = false,
          el          = document.createElement("fakeelement"),
          transitions = {
            "WebkitTransition" : "webkitTransitionEnd",
            "MozTransition"    : "transitionend",
            "OTransition"      : "otransitionend",
            "transition"       : "transitionend"
          };

      for (t in transitions) {
        if (el.style[t] !== undefined) {
          type      = transitions[t];
          supported = true;
          break;
        }
      }

      return {
        type      : type,
        supported : supported
      };
    };

    /**
     * Shorthand for document.getElementById()
     */
    $ = function (id) {
      return document.getElementById(id);
    };

    /**
     * Notification private object
     */
    _notification = {
      /**
       * Delay number
       */
      delay : 2000,

      /**
       * Set the transition event on load
       */
      transition : undefined,

      /**
       * Bind events to elements
       */
      bind : function (el, event, fn) {
        if (typeof el.addEventListener === "function") {
          el.addEventListener(event, fn, false);
        } else if (el.attachEvent) {
          el.attachEvent("on" + event, fn);
        }
      },

      /**
       * Unbind events to elements
       */
      unbind : function (el, event, fn) {
        if (typeof el.removeEventListener === "function") {
          el.removeEventListener(event, fn, false);
        } else if (el.detachEvent) {
          el.detachEvent("on" + event, fn);
        }
      },

      /**
       * Close the log messages
       */
      close : function (elem, wait) {
        var timer = (wait && !isNaN(wait)) ? +wait : this.delay,
            self  = this,
            hideElement, transitionDone;

        // set click event on log messages
        this.bind(elem, "click", function () {
          hideElement(elem);
        });

        // Hide the dialog box after transition
        transitionDone = function (event) {
          event.stopPropagation();
          self.unbind(this, self.transition.type, transitionDone);
          if (elLog && elLog.removeChild) {
            elLog.removeChild(this);
          }
          if (elLog && !elLog.hasChildNodes()) {
            elLog.className += " notification-logs-hidden";
          }
        };

        hideElement = function (el) {
          if (typeof el !== "undefined" && el.parentNode === elLog) {
            if (self.transition.supported) {
              self.bind(el, self.transition.type, transitionDone);
              el.className += " notification-log-hide";
            } else {
              if (elLog && elLog.removeChild) {
                elLog.removeChild(el);
              }
              if (elLog && !elLog.hasChildNodes()) {
                elLog.className += " notification-logs-hidden";
              }
            }
          }
        };

        // never close (until click) if wait is set to 0
        if (wait === 0) return;

        // set timeout to auto close the log message
        setTimeout(function () { hideElement(elem); }, timer);
      },

      /**
       * Initialize Notification
       */
      init : function () {
        // log element
        if ($("notification-logs") == null) {
          elLog = document.createElement("section");
          elLog.setAttribute("id", "notification-logs");
          elLog.className = "notification-logs notification-logs-hidden";
          document.body.appendChild(elLog);
        }

        // set transition type
        this.transition = getTransitionEvent();
      },

      /**
       * Show a new log message box
       */
      log : function (message, type, wait) {
        var check = function () {
          if (elLog && elLog.scrollTop !== null) return;
          else setTimeout(check, 10);
        };

        this.init();
        check();

        elLog.className = "notification-logs";
        this.notify(message, type, wait);

        return this;
      },

      /**
       * Add new log message
       */
      notify : function (message, type, wait) {
        var log = document.createElement("article");
        log.className = "notification-log" + ((typeof type === "string" && type !== "") ? " notification-log-" + type : "");
        log.innerHTML = message;

        // append child
        elLog.appendChild(log);

        // triggers the CSS animation
        setTimeout(function() { log.className = log.className + " notification-log-show"; }, 50);

        this.close(log, wait);
      },

      /**
       * Set properties
       */
      set : function (args) {
        var k;
        if (typeof args !== "object" && args instanceof Array) throw new Error("args must be an object");

        for (k in args) {
          if (args.hasOwnProperty(k)) {
            this[k] = args[k];
          }
        }
      }
    };

    return {
      log     : function (message, type, wait) { _notification.log(message, type, wait); return this; },
      success : function (message, wait) { _notification.log(message, "success", wait); return this; },
      error   : function (message, wait) { _notification.log(message, "error", wait); return this; },
      set     : function (args) { _notification.set(args); }
    };
  };

  // Global support
  if (typeof global.notification === "undefined") {
    global.notification = new Notification();
  }
}(this));

