import adapter from './external/adapter-latest'
import { SoundMeter } from './soundmeter.js'
/**
 * Media management class is responsible to manage audio and video
 * sources and tracks management for the local stream.
 * Also audio and video properties (like bitrate) are managed by this class .
 */
export class MediaManager {
  constructor(initialValues) {
    /**
     * the maximum bandwith value that browser can send a stream
     * keep in mind that browser may send video less than this value
     */
    this.bandwidth = 900 //kbps

    /**
     * This flags enables/disables debug logging
     */
    this.debug = false

    /**
     * The cam_location below is effective when camera and screen is send at the same time.
     * possible values are top and bottom. It's on right all the time
     */
    this.camera_location = 'top'

    /**
     * The cam_margin below is effective when camera and screen is send at the same time.
     * This is the margin value in px from the edges
     */
    this.camera_margin = 15

    /**
     * this camera_percent is how large the camera view appear on the screen. It's %15 by default.
     */
    this.camera_percent = 15

    /**
     * initial media constraints provided by the user
     */
    this.mediaConstraints = null

    /**
     * this is the callback function to get video/audio sender from WebRTCAdaptor
     */
    this.getSender = initialValues.getSender

    /**
     * This is the Stream Id for the publisher.
     */
    this.publishStreamId = null

    /**
     * this is the object of the local stream to publish
     * it is initiated in initLocalStream method
     */
    this.localStream = null

    /*
     * publish mode is determined by the user
     * It may be camera, screen, screen+camera
     */
    this.publishMode = 'camera' //screen, screen+camera

    /*
     * audio mode is determined by the user
     * It may be system, microphone, system+microphone
     */
    this.audioMode = 'system+microphone' //system, microphone, system+microphone

    /**
     * The values of the above fields are provided as user parameters by the constructor.
     * TODO: Also some other hidden parameters may be passed here
     */
    for (var key in initialValues.userParameters) {
      if (initialValues.userParameters.hasOwnProperty(key)) {
        this[key] = initialValues.userParameters[key]
      }
    }

    /**
     * current volume value which is set by the user
     */
    this.currentVolume = null

    /**
     * Keeps the audio track to be closed in case of audio track change
     */
    this.previousAudioTrack = null

    /**
     * The screen video track in screen+camera mode
     */
    this.desktopStream = null

    /**
     * The camera (overlay) video track in screen+camera mode
     */
    this.smallVideoTrack = null

    /**
     * Audio context to use for meter, mix, gain
     */
    this.audioContext = new AudioContext()

    /**
     * the main audio in single audio case
     * the primary audio in mixed audio case
     *
     * its volume can be controled
     */
    this.primaryAudioTrackGainNode = null

    /**
     * the secondary audio in mixed audio case
     *
     * its volume can be controled
     */
    this.secondaryAudioTrackGainNode = null

    /**
     * this is the sound meter object for the local stream
     */
    this.localStreamSoundMeter = null

    /**
     * Timer to create black frame to publish when video is muted
     */
    this.blackFrameTimer = null

    /**
     * For audio check when the user is muted itself.
     * Check enableAudioLevelWhenMuted
     */
    this.mutedAudioStream = null

    /**
     * This flag is the status of audio stream
     * Checking when the audio stream is updated
     */
    this.isMuted = false

    /**
     * meter refresh period for "are you talking?" check
     */
    this.meterRefresh = null

    /**
     * For keeping track of whether user turned off the camera
     */
    this.cameraEnabled = true

    /**
     * html video element that presents local stream
     */
    this.localVideo = document.getElementById(this.localVideoId)

    // A dummy stream created to replace the tracks when camera is turned off.
    this.dummyCanvas = document.createElement('canvas')

    /**
     * The timer id for SoundMeter for the local stream
     */
    this.soundLevelProviderId = -1

    // Check browser support for screen share function
    this.checkBrowserScreenShareSupported()

    this.tempTracks = []

    this.initialized = false
  }

  /**
   * Called by the WebRTCAdaptor at the start if it isn't play mode
   */
  async initialize() {
    if (!this.initialized) return false

    this.checkWebRTCPermissions()

    // Get devices only in publish mode.
    await this.getDevices()
    this.trackDeviceChange()

    this.initialized = true

    return true
  }

  /*
   * Called to checks if Websocket and media usage are allowed
   */
  checkWebRTCPermissions() {
    if (!('WebSocket' in window)) {
      console.log('WebSocket not supported.')
      this.callbackError('WebSocketNotSupported')
      return
    }

    if (typeof navigator.mediaDevices == 'undefined') {
      console.log(
        'Cannot open camera and mic because of unsecure context. Please Install SSL(https)',
      )
      this.callbackError('UnsecureContext')
      return
    }
    if (typeof navigator.mediaDevices == 'undefined' || navigator.mediaDevices == null) {
      this.callbackError('getUserMediaIsNotAllowed')
    }
  }

  /*
   * Called to get the available video and audio devices on the system
   */
  async getDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()

      let deviceArray = new Array()
      let checkAudio = false
      let checkVideo = false

      devices.forEach((device) => {
        if (device.kind == 'audioinput' || device.kind == 'videoinput') {
          deviceArray.push(device)
          if (device.kind == 'audioinput') {
            checkAudio = true
          }
          if (device.kind == 'videoinput') {
            checkVideo = true
          }
        }
      })
      this.callback('available_devices', deviceArray)

      // TODO: is the following part necessary. why?
      if (checkAudio == false && this.localStream == null) {
        console.log('Audio input not found')
        console.log('Retrying to get user media without audio')

        if (this.inputDeviceNotFoundLimit < 2) {
          if (checkVideo != false) {
            this.openStream({ video: true, audio: false })
            this.inputDeviceNotFoundLimit++
          } else {
            console.log('Video input not found')
            alert('There is no video or audio input')
          }
        } else {
          alert('No input device found, publish is not possible')
        }
      }
    } catch (err) {
      console.error('Cannot get devices -> error name: ' + err.name + ': ' + err.message)
    }
  }

  /*
   * Called to add a device change listener
   */
  trackDeviceChange() {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      this.getDevices()
    })
  }

  /**
   * This function create a canvas which combines screen video and camera video as an overlay
   *
   * @param {*} stream : screen share stream
   * @param {*} streamId
   * @param {*} onEndedCallback : callback when called on screen share stop
   */
  async setDesktopWithCameraSource(stream, streamId, onEndedCallback) {
    this.desktopStream = stream
    const cameraStream = await this.getUserMedia({ video: true, audio: false }, true)

    this.smallVideoTrack = cameraStream.getVideoTracks()[0]

    // create a canvas element
    const canvas = document.createElement('canvas')
    const canvasContext = canvas.getContext('2d')

    // create video element for screen
    // var screenVideo = document.getElementById('sourceVideo');
    const screenVideo = document.createElement('video')

    screenVideo.srcObject = stream
    screenVideo.play()
    // create video element for camera
    const cameraVideo = document.createElement('video')

    cameraVideo.srcObject = cameraStream
    cameraVideo.play()
    const canvasStream = canvas.captureStream(15)

    if (this.localStream == null) {
      this.gotStream(canvasStream)
    } else {
      this.updateVideoTrack(canvasStream, streamId, onEndedCallback, null)
    }

    // update the canvas
    setInterval(() => {
      // draw screen to canvas
      canvas.width = screenVideo.videoWidth
      canvas.height = screenVideo.videoHeight
      canvasContext.drawImage(screenVideo, 0, 0, canvas.width, canvas.height)

      const cameraWidth = screenVideo.videoWidth * (this.camera_percent / 100)
      const cameraHeight = (cameraVideo.videoHeight / cameraVideo.videoWidth) * cameraWidth

      const positionX = canvas.width - cameraWidth - this.camera_margin
      let positionY

      if (this.camera_location == 'top') {
        positionY = this.camera_margin
      } else {
        // if not top, make it bottom
        // draw camera on right bottom corner
        positionY = canvas.height - cameraHeight - this.camera_margin
      }
      canvasContext.drawImage(cameraVideo, positionX, positionY, cameraWidth, cameraHeight)
    }, 66)
  }

  getMediaConstraints() {
    const mediaConstraints = { ...this.mediaConstraints }
    if (!this.audioMode) mediaConstraints.audio = false

    return mediaConstraints
  }

  async prepareStream(stream, streamId) {
    const { audio } = this.getMediaConstraints()

    if (this.smallVideoTrack) this.smallVideoTrack.stop()
    return this.prepareStreamTracks(this.mediaConstraints, audio, stream, streamId)
  }

  /**
   * This function does these:
   * 	1. Remove the audio track from the stream provided if it is camera. Other case
   * 	   is screen video + system audio track. In this case audio is kept in stream.
   * 	2. Open audio track again if audio constaint isn't false
   * 	3. Make audio track Gain Node to be able to volume adjustable
   *  4. If screen is shared and system audio is available then the system audio and
   *     opened audio track are mixed, depending on the audio mode
   *
   * @param {*} mediaConstraints
   * @param {*} audioConstraint
   * @param {*} deviceStream
   * @param {*} streamId
   */
  async prepareStreamTracks(mediaConstraints, audioConstraint, deviceStream, streamId) {
    // this trick, getting audio and video separately, make us add or remove tracks on the fly
    const audioTracks = deviceStream.getAudioTracks()
    if (audioTracks.length > 0 && this.publishMode == 'camera') {
      audioTracks[0].stop()
      deviceStream.removeTrack(audioTracks[0])
    }

    //add callback if desktop is sharing
    const onEnded = (event) => {
      this.callback('screen_share_stopped')
    }

    if (this.publishMode == 'screen') {
      this.updateVideoTrack(deviceStream, streamId, onEnded, true)
    } else if (this.publishMode == 'screen+camera') {
      this.setDesktopWithCameraSource(deviceStream, streamId, onEnded)
    }

    // now get only audio to add this stream
    if (audioConstraint) {
      // Here audioStream has one audio track only
      const audioStream = await this.prepareAudioStream(deviceStream, audioConstraint)

      if (this.publishMode !== 'camera') {
        this.updateAudioTrack(audioStream, streamId, null)
      } else if (this.publishMode === 'camera') {
        deviceStream.addTrack(audioStream.getAudioTracks()[0])
      }
    }

    this.gotStream(deviceStream)

    return deviceStream
  }

  async prepareAudioStream(deviceStream, audioConstraint) {
    if (this.audioMode === 'microphone') {
      let audioStream = await this.getUserMedia({ audio: audioConstraint }, true)
      audioStream = this.setGainNodeStream(audioStream)

      // Now audio stream has one audio stream.
      // 1. Gain Node : this will be added to local stream to publish
      return audioStream
    } else if (this.audioMode === 'system') {
      // We only want system audio
      return deviceStream
    } else if (this.audioMode === 'system+microphone') {
      let audioStream = await this.getUserMedia({ audio: audioConstraint }, true)
      audioStream = this.setGainNodeStream(audioStream)

      // We want both system audio and microphone, mix them
      audioStream = this.mixAudioStreams(deviceStream, audioStream)

      // Now audio stream has two audio streams.
      // 1. Gain Node : this will be added to local stream to publish
      // 2. Original audio track : keep its reference to stop later
      return audioStream
    }

    return deviceStream
  }

  /**
   * Called to get user media (camera and/or mic)
   *
   * @param {*} mediaConstraints : media constaint
   * @param {*} func : callback on success. The stream which is got, is passed as parameter to this function
   * @param {*} catch_error : error is checked if catch_error is true
   */
  async getUserMedia(mediaConstraints, catch_error = false) {
    if (catch_error == true) {
      try {
        return await navigator.mediaDevices.getUserMedia(mediaConstraints)
      } catch (error) {
        if (error.name == 'NotFoundError') {
          this.getDevices()
        } else {
          this.callbackError(error.name, error.message)

          throw error
        }
      }
    } else {
      return navigator.mediaDevices.getUserMedia(mediaConstraints)
    }
  }

  /**
   * Called to get display media (screen share)
   *
   * @param {*} mediaConstraints : media constaint
   * @param {*} func : callback on success. The stream which is got, is passed as parameter to this function
   */
  async getDisplayMedia(mediaConstraints) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(mediaConstraints)
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        const fallback = this.callbackError('ScreenSharePermissionDenied')

        if (fallback !== false) {
          // If error catched then redirect Default Stream Camera
          if (this.localStream == null) {
            const mediaConstraints = {
              video: true,
              audio: true,
            }

            return this.openStream(mediaConstraints)
          } else {
            return this.switchVideoCameraCapture(streamId)
          }
        }
      }

      throw error
    }
  }

  /**
   * Called to get the media (User Media or Display Media)
   * @param {*} mediaConstraints
   */
  async getMedia(mediaConstraints) {
    // Check Media Constraint video value screen or screen + camera
    if (this.publishMode == 'screen+camera' || this.publishMode == 'screen') {
      return this.getDisplayMedia(mediaConstraints)
    }
    // If mediaConstraints only user camera
    else {
      return this.getUserMedia(mediaConstraints, true)
    }
  }

  /**
   * Open media stream, it may be screen, camera or audio
   */
  async openStream(mediaConstraints, streamId) {
    this.mediaConstraints = mediaConstraints

    const mConstraints = this.getMediaConstraints()

    if (typeof mConstraints.video != 'undefined') {
      const stream = await this.getMedia(mConstraints)
      return this.prepareStream(stream, streamId)
    } else {
      this.localStream = null
      console.error('MediaConstraint video is not defined')
      this.callbackError('media_constraint_video_not_defined')
    }
  }

  /**
   * Closes stream, if you want to stop peer connection, call stop(streamId)
   */
  closeStream() {
    if (this.localStream != null) {
      this.tempTracks.forEach((track) => track.stop())
      this.localStream.getVideoTracks().forEach((track) => track.stop())
      this.localStream.getAudioTracks().forEach((track) => track.stop())

      this.tempTracks = []
    }

    this.videoTrack?.stop()
    this.audioTrack?.stop()
    this.smallVideoTrack?.stop()
    this.previousAudioTrack?.stop()

    if (this.soundLevelProviderId != -1) {
      clearInterval(this.soundLevelProviderId)
      this.soundLevelProviderId = -1
    }

    this.localStream = null
  }

  isBrowserScreenShareSupported() {
    return (
      (typeof navigator.mediaDevices != 'undefined' && navigator.mediaDevices.getDisplayMedia) ||
      navigator.getDisplayMedia
    )
  }

  /**
   * Checks browser supports screen share feature
   * if exist it calls callback with "browser_screen_share_supported"
   */
  checkBrowserScreenShareSupported() {
    if (this.isBrowserScreenShareSupported()) {
      this.callback('browser_screen_share_supported')
    }
  }

  /**
   * Changes the secondary stream gain in mixed audio mode
   *
   * @param {*} enable
   */
  enableSecondStreamInMixedAudio(enable) {
    if (this.secondaryAudioTrackGainNode == null) reeturn

    if (enable) {
      this.secondaryAudioTrackGainNode.gain.value = 1
    } else {
      this.secondaryAudioTrackGainNode.gain.value = 0
    }
  }

  /**
   * Changes local stream when new stream is prepared
   *
   * @param {*} stream
   */
  gotStream(stream) {
    this.localStream = stream

    if (this.localVideo) {
      this.localVideo.srcObject = stream
    }
  }

  /**
   * These methods are initialized when the user is muted himself in a publish scenario
   * It will keep track if the user is trying to speak without sending any data to server
   * Please don't forget to disable this function with disableAudioLevelWhenMuted if you use it.
   */
  async enableAudioLevelWhenMuted() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })

      this.mutedAudioStream = stream
      const soundMeter = new SoundMeter(this.audioContext)
      soundMeter.connectToSource(this.mutedAudioStream, (e) => {
        if (e) {
          alert(e)
          return
        }
        this.meterRefresh = setInterval(() => {
          if (soundMeter.instant.toFixed(2) > 0.1) {
            this.callback('speaking_but_muted')
          }
        }, 200)
      })
    } catch (error) {
      console.error("Can't get the soundlevel on mute", error)
    }
  }

  disableAudioLevelWhenMuted() {
    if (this.meterRefresh != null) {
      clearInterval(this.meterRefresh)
    }

    if (this.mutedAudioStream != null) {
      this.mutedAudioStream.getTracks().forEach((track) => track.stop())
    }
  }

  /**
   * This method mixed the first stream audio to the second stream audio and
   * @param {*} stream  : Primary stream that contain video and audio (system audio)
   * @param {*} secondStream :stream has device audio
   * @returns mixed stream.
   */
  mixAudioStreams(stream, secondStream) {
    // console.debug("audio stream track count: " + audioStream.getAudioTracks().length);
    const composedStream = new MediaStream()

    // added the video stream from the screen
    stream.getVideoTracks().forEach((track) => composedStream.addTrack(track))

    this.audioContext = new AudioContext()
    const audioDestination = this.audioContext.createMediaStreamDestination()

    if (stream.getAudioTracks().length > 0) {
      this.primaryAudioTrackGainNode = this.audioContext.createGain()

      // Adjust the gain for screen sound
      this.primaryAudioTrackGainNode.gain.value = 1

      const audioSource = this.audioContext.createMediaStreamSource(stream)
      audioSource.connect(this.primaryAudioTrackGainNode).connect(audioDestination)
    } else {
      console.debug('Origin stream does not have audio track')
    }

    if (secondStream.getAudioTracks().length > 0) {
      this.secondaryAudioTrackGainNode = this.audioContext.createGain()

      // Adjust the gain for second sound
      this.secondaryAudioTrackGainNode.gain.value = 1

      const audioSource2 = this.audioContext.createMediaStreamSource(secondStream)
      audioSource2.connect(this.secondaryAudioTrackGainNode).connect(audioDestination)
    } else {
      console.debug('Second stream does not have audio track')
    }

    audioDestination.stream.getAudioTracks().forEach((track) => {
      composedStream.addTrack(track)
    })

    return composedStream
  }

  /**
   * This method creates a Gain Node stream to make the audio track adjustable
   *
   * @param {*} stream
   * @returns
   */
  setGainNodeStream(stream) {
    const mediaConstraints = this.getMediaConstraints()

    if (mediaConstraints.audio) {
      // Get the videoTracks from the stream.
      const videoTracks = stream.getVideoTracks()

      // Get the audioTracks from the stream.
      const audioTracks = stream.getAudioTracks()

      /**
       * Create a new audio context and build a stream source,
       * stream destination and a gain node. Pass the stream into
       * the mediaStreamSource so we can use it in the Web Audio API.
       */
      this.audioContext = new AudioContext()
      let mediaStreamSource = this.audioContext.createMediaStreamSource(stream)
      let mediaStreamDestination = this.audioContext.createMediaStreamDestination()
      this.primaryAudioTrackGainNode = this.audioContext.createGain()

      /**
       * Connect the stream to the gainNode so that all audio
       * passes through the gain and can be controlled by it.
       * Then pass the stream from the gain to the mediaStreamDestination
       * which can pass it back to the RTC client.
       */
      mediaStreamSource.connect(this.primaryAudioTrackGainNode)
      this.primaryAudioTrackGainNode.connect(mediaStreamDestination)

      if (this.currentVolume == null) {
        this.primaryAudioTrackGainNode.gain.value = 1
      } else {
        this.primaryAudioTrackGainNode.gain.value = this.currentVolume
      }

      /**
       * The mediaStreamDestination.stream outputs a MediaStream object
       * containing a single AudioMediaStreamTrack. Add the video track
       * to the new stream to rejoin the video with the controlled audio.
       */
      const controlledStream = mediaStreamDestination.stream

      for (const videoTrack of videoTracks) {
        controlledStream.addTrack(videoTrack)
      }
      for (const audioTrack of audioTracks) {
        controlledStream.addTrack(audioTrack)
      }

      if (this.previousAudioTrack != null) {
        this.previousAudioTrack.stop()
      }
      this.previousAudioTrack = controlledStream.getAudioTracks()[1]

      /**
       * Use the stream that went through the gainNode. This
       * is the same stream but with altered input volume levels.
       */
      return controlledStream
    }
    return stream
  }

  /**
   * Called by User
   * to switch the Screen Share mode
   *
   * @param {*} streamId
   */
  async switchDesktopCapture(streamId) {
    this.publishMode = 'screen'

    const mediaConstraints = this.getMediaConstraints()

    const stream = await this.getMedia(mediaConstraints)
    return this.prepareStream(stream, streamId)
  }

  /**
   * Called by User
   * to switch the Screen Share with Camera mode
   *
   * @param {*} streamId
   */
  async switchDesktopCaptureWithCamera(streamId) {
    this.publishMode = 'screen+camera'

    const mediaConstraints = this.getMediaConstraints()

    const stream = await this.getMedia(mediaConstraints)
    return this.prepareStream(stream, streamId)
  }

  /**
   * This method updates the local stream. It removes existant audio track from the local stream
   * and add the audio track in `stream` parameter to the local stream
   */
  updateLocalAudioStream(stream, onEndedCallback) {
    const newAudioTrack = stream.getAudioTracks()[0]

    if (this.localStream != null) {
      const audioTrack = this.localStream.getAudioTracks()[0]

      if (audioTrack != null && newAudioTrack) newAudioTrack.onended = audioTrack.onended

      if (audioTrack != null && audioTrack != newAudioTrack) {
        this.tempTracks.push(audioTrack)

        this.localStream.removeTrack(audioTrack)
        newAudioTrack && this.localStream.addTrack(newAudioTrack)
      } else {
        newAudioTrack && this.localStream.addTrack(newAudioTrack)
      }
    } else {
      this.localStream = stream
    }

    if (this.localVideo != null) {
      this.localVideo.srcObject = this.localStream
    }

    if (onEndedCallback != null && onEndedCallback) {
      stream.getAudioTracks()[0].onended = onEndedCallback
    }

    if (this.isMuted) {
      this.muteLocalMic()
    } else {
      this.unmuteLocalMic()
    }

    if (this.localStreamSoundMeter != null) {
      this.connectSoundMeterToLocalStream()
    }
  }

  /**
   * This method updates the local stream. It removes existant video track from the local stream
   * and add the video track in `stream` parameter to the local stream
   */
  updateLocalVideoStream(stream, onEndedCallback, stopDesktop) {
    if (stopDesktop && this.desktopStream != null) {
      this.desktopStream.getVideoTracks()[0].stop()
    }

    const newVideoTrack = stream.getVideoTracks()[0]

    if (this.localStream != null && this.localStream.getVideoTracks()[0] != null) {
      const videoTrack = this.localStream.getVideoTracks()[0]

      this.localStream.removeTrack(videoTrack)
      videoTrack.stop()

      this.localStream.addTrack(newVideoTrack)
    } else if (this.localStream != null) {
      this.localStream.addTrack(newVideoTrack)
    } else {
      this.localStream = stream
    }

    if (this.localVideo) {
      this.localVideo.srcObject = this.localStream
    }

    if (onEndedCallback != null) {
      stream.getVideoTracks()[0].onended = onEndedCallback
    }
  }

  /**
   * Called by User
   * to change video source
   *
   * @param {*} streamId
   * @param {*} deviceId
   */
  switchAudioInputSource(streamId, deviceId) {
    //stop the track because in some android devices need to close the current camera stream
    const audioTrack = this.localStream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.stop()
    } else {
      console.warn('There is no audio track in local stream')
    }

    if (typeof deviceId != 'undefined') {
      if (this.mediaConstraints.audio !== true) this.mediaConstraints.audio.deviceId = deviceId
      else this.mediaConstraints.audio = { deviceId: deviceId }

      //to change only audio track set video false otherwise issue #3826 occurs on Android
      let tempMediaConstraints = { video: false, audio: { deviceId: deviceId } }
      this.setAudioInputSource(streamId, tempMediaConstraints, null, true, deviceId)
    } else {
      this.setAudioInputSource(streamId, this.getMediaConstraints(), null, true, deviceId)
    }
  }

  /**
   * This method sets Audio Input Source and called when you change audio device
   * It calls updateAudioTrack function to update local audio stream.
   */
  async setAudioInputSource(streamId, mediaConstraints, onEndedCallback) {
    if (!mediaConstraints.audio) {
      const audioTracks = this.devices.getAudioTracks()

      if (audioTracks.length > 0) {
        audioTracks.forEach((track) => {
          track.stop()
          this.localStream.removeTrack(track)
        })
      }

      return this.updateLocalAudioStream(this.localStream, onEndedCallback)
    }

    const audioStream = await this.prepareAudioStream(deviceStream, mediaConstraints.audio)
    this.updateAudioTrack(audioStream, streamId, mediaConstraints, onEndedCallback)

    return audioStream
  }

  /**
   * Called by User
   * to change video camera capture
   *
   * @param {*} streamId Id of the stream to be changed.
   * @param {*} deviceId Id of the device which will use as a media device
   * @param {*} onEndedCallback callback for when the switching video state is completed, can be used to understand if it is loading or not
   *
   * This method is used to switch to video capture.
   */
  async switchVideoCameraCapture(streamId, deviceId) {
    // stop the track because in some android devices need to close the current camera stream
    const videoTrack = this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.stop()
    } else {
      console.warn('There is no video track in local stream')
    }

    this.publishMode = 'camera'
    const devices = await navigator.mediaDevices.enumerateDevices()

    for (let i = 0; i < devices.length; i++) {
      if (devices[i].kind == 'videoinput') {
        //Adjust video source only if there is a matching device id with the given one.
        //It creates problems if we don't check that since video can be just true to select default cam and it is like that in many cases.
        if (devices[i].deviceId == deviceId) {
          if (this.mediaConstraints.video !== true)
            this.mediaConstraints.video.deviceId = { exact: deviceId }
          else this.mediaConstraints.video = { deviceId: { exact: deviceId } }
          break
        }
      }
    }
    //If no matching device found don't adjust the media constraints let it be true instead of a device ID
    console.debug(
      'Given deviceId = ' +
        deviceId +
        ' - Media constraints video property = ' +
        this.mediaConstraints.video,
    )
    this.setVideoCameraSource(
      streamId,
      { video: this.getMediaConstraints().video },
      null,
      true,
      deviceId,
    )

    return deviceId
  }

  /**
   * This method sets Video Input Source and called when you change video device
   * It calls updateVideoTrack function to update local video stream.
   */
  async setVideoCameraSource(streamId, mediaConstraints, onEndedCallback, stopDesktop) {
    let stream = await this.getUserMedia(mediaConstraints, true)

    if (stopDesktop && this.secondaryAudioTrackGainNode && stream.getAudioTracks().length > 0) {
      //This audio track update is necessary for such a case:
      //If you enable screen share with browser audio and then
      //return back to the camera, the audio should be only from mic.
      //If, we don't update audio with the following lines,
      //the mixed (mic+browser) audio would be streamed in the camera mode.
      this.secondaryAudioTrackGainNode = null
      stream = this.setGainNodeStream(stream)
      this.updateAudioTrack(stream, streamId, mediaConstraints, onEndedCallback)
    }

    if (this.cameraEnabled) {
      this.updateVideoTrack(stream, streamId, onEndedCallback, stopDesktop)
    } else {
      this.turnOffLocalCamera()
    }

    return stream
  }

  /**
   * Called by User
   * to switch between front and back camera on mobile devices
   *
   * @param {*} streamId Id of the stream to be changed.
   * @param {*} facingMode it can be "user" or "environment"
   *
   * This method is used to switch front and back camera.
   */
  switchVideoCameraFacingMode(streamId, facingMode) {
    //stop the track because in some android devices need to close the current camera stream
    var videoTrack = this.localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.stop()
    } else {
      console.warn('There is no video track in local stream')
    }

    // When device id set, facing mode is not working
    // so, remove device id
    if (
      this.mediaConstraints.video !== undefined &&
      this.mediaConstraints.video.deviceId !== undefined
    ) {
      delete this.mediaConstraints.video.deviceId
    }

    var videoConstraint = {
      facingMode: facingMode,
    }

    this.mediaConstraints.video = Object.assign({}, this.mediaConstraints.video, videoConstraint)

    this.publishMode = 'camera'
    console.debug('Media constraints video property = ' + this.mediaConstraints.video)
    this.setVideoCameraSource(streamId, { video: this.getMediaConstraints().video }, null, true)
  }

  /**
   * Updates the audio track in the audio sender
   * getSender method is set on MediaManagercreation by WebRTCAdaptor
   *
   * @param {*} stream
   * @param {*} streamId
   * @param {*} onEndedCallback
   */
  async updateAudioTrack(stream, streamId, onEndedCallback) {
    const audioTrackSender = this.getSender(streamId, 'audio')
    if (audioTrackSender) {
      await audioTrackSender.replaceTrack(stream.getAudioTracks()[0])

      return this.updateLocalAudioStream(stream, onEndedCallback)
    } else {
      return this.updateLocalAudioStream(stream, onEndedCallback)
    }
  }

  /**
   * Updates the video track in the video sender
   * getSender method is set on MediaManagercreation by WebRTCAdaptor
   *
   * @param {*} stream
   * @param {*} streamId
   * @param {*} onEndedCallback
   */
  async updateVideoTrack(stream, streamId, onEndedCallback, stopDesktop) {
    const videoTrackSender = this.getSender(streamId, 'video')
    if (videoTrackSender) {
      await videoTrackSender.replaceTrack(stream.getVideoTracks()[0])

      this.updateLocalVideoStream(stream, onEndedCallback, stopDesktop)
    } else {
      this.updateLocalVideoStream(stream, onEndedCallback, stopDesktop)
    }
  }

  /**
   * If you mute turn off the camera still some data should be sent
   * Tihs method create a black frame to reduce data transfer
   */
  initializeDummyFrame() {
    this.dummyCanvas.getContext('2d').fillRect(0, 0, 320, 240)
    this.replacementStream = this.dummyCanvas.captureStream()
  }

  /**
   * Called by User
   * turns of the camera stream and starts streaming black dummy frame
   */
  turnOffLocalCamera(streamId) {
    //Initialize the first dummy frame for switching.
    this.initializeDummyFrame()

    if (this.localStream != null) {
      let choosenId
      if (streamId != null || typeof streamId != 'undefined') {
        choosenId = streamId
      } else {
        choosenId = this.publishStreamId
      }
      this.cameraEnabled = false
      this.updateVideoTrack(this.replacementStream, choosenId, null, true)
    } else {
      this.callbackError('NoActiveConnection')
    }

    //We need to send black frames within a time interval, because when the user turn off the camera,
    //player can't connect to the sender since there is no data flowing. Sending a black frame in each 3 seconds resolves it.
    if (this.blackFrameTimer == null) {
      this.blackFrameTimer = setInterval(() => {
        this.initializeDummyFrame()
      }, 3000)
    }
  }

  /**
   * Called by User
   * turns of the camera stream and starts streaming camera again instead of black dummy frame
   */
  async turnOnLocalCamera(streamId) {
    const mediaConstraints = this.getMediaConstraints()

    if (this.blackFrameTimer != null) {
      clearInterval(this.blackFrameTimer)
      this.blackFrameTimer = null
    }

    if (this.localStream == null) {
      const stream = await this.getUserMedia({ video: mediaConstraints.video }, false)

      this.gotStream(stream)

      return stream
    }
    //This method will get the camera track and replace it with dummy track
    else {
      const stream = await this.getUserMedia({ video: mediaConstraints.video }, false)

      let choosenId
      if (streamId != null || typeof streamId != 'undefined') {
        choosenId = streamId
      } else {
        choosenId = this.publishStreamId
      }
      this.cameraEnabled = true
      this.updateVideoTrack(stream, choosenId, null, true)

      return stream
    }
  }

  /**
   * Called by User
   * to mute local audio streaming
   */
  muteLocalMic() {
    this.isMuted = true
    if (this.localStream != null) {
      this.localStream.getAudioTracks().forEach((track) => (track.enabled = false))
    } else {
      this.callbackError('NoActiveConnection')
    }
  }

  /**
   * Called by User
   * to unmute local audio streaming
   *
   * if there is audio it calls callbackError with "AudioAlreadyActive" parameter
   */
  unmuteLocalMic() {
    this.isMuted = false
    if (this.localStream != null) {
      this.localStream.getAudioTracks().forEach((track) => (track.enabled = true))
    } else {
      this.callbackError('NoActiveConnection')
    }
  }

  /**
   * If we have multiple video tracks in coming versions, this method may cause some issues
   */
  getVideoSender(streamId) {
    var videoSender = null
    if (
      adapter != null &&
      (adapter.browserDetails.browser === 'chrome' ||
        adapter.browserDetails.browser === 'firefox' ||
        (adapter.browserDetails.browser === 'safari' && adapter.browserDetails.version >= 64)) &&
      'RTCRtpSender' in window &&
      'setParameters' in window.RTCRtpSender.prototype
    ) {
      videoSender = this.getSender(streamId, 'video')
    }
    return videoSender
  }

  /**
   * Called by User
   * to set audio mode
   */
  async changeAudioMode(audioMode, streamId) {
    this.audioMode = audioMode

    const mediaConstraints = this.getMediaConstraints()

    let promise = Promise.resolve()
    if (mediaConstraints.video !== undefined) {
      if (this.localStream && this.localStream.getVideoTracks().length > 0) {
        const videoTrack = this.localStream.getVideoTracks()[0]
        promise = videoTrack.applyConstraints(this.mediaConstraints.video)
      } else {
        promise = new Promise((resolve, reject) => {
          reject('There is no video track to apply constraints')
        })
      }
    }

    if (mediaConstraints.audio !== undefined && streamId) {
      // just give the audio constraints not to get video stream
      promise = this.setAudioInputSource(streamId, { audio: mediaConstraints.audio }, null)
    }

    return promise
  }

  /**
   * Called by User
   * to set maximum video bandwidth is in kbps
   */
  changeBandwidth(bandwidth, streamId) {
    let errorDefinition = ''

    const videoSender = this.getVideoSender(streamId)

    if (videoSender != null) {
      const parameters = videoSender.getParameters()

      if (!parameters.encodings) {
        parameters.encodings = [{}]
      }

      if (bandwidth === 'unlimited') {
        delete parameters.encodings[0].maxBitrate
      } else {
        parameters.encodings[0].maxBitrate = bandwidth * 1000
      }

      return videoSender.setParameters(parameters)
    } else {
      errorDefinition = 'Video sender not found to change bandwidth. Streaming may not be active'
    }

    return Promise.reject(errorDefinition)
  }

  /**
   * Called by user
   * sets the volume level
   *
   * @param {*} volumeLevel : Any number between 0 and 1.
   */
  setVolumeLevel(volumeLevel) {
    this.currentVolume = volumeLevel
    if (this.primaryAudioTrackGainNode != null) {
      this.primaryAudioTrackGainNode.gain.value = volumeLevel
    }

    if (this.secondaryAudioTrackGainNode != null) {
      this.secondaryAudioTrackGainNode.gain.value = volumeLevel
    }
  }

  /**
   * Called by user
   * To create a sound meter for the local stream
   *
   * @param {*} levelCallback : callback to provide the audio level to user
   * @param {*} period : measurement period
   */
  enableAudioLevelForLocalStream(levelCallback, period) {
    this.localStreamSoundMeter = new SoundMeter(this.audioContext)
    this.connectSoundMeterToLocalStream()

    this.soundLevelProviderId = setInterval(() => {
      levelCallback(this.localStreamSoundMeter.instant.toFixed(2))
    }, period)
  }

  /**
   * Connects the local stream to Sound Meter
   * It should be called when local stream changes
   */
  connectSoundMeterToLocalStream() {
    this.localStreamSoundMeter.connectToSource(this.localStream, function (e) {
      if (e) {
        alert(e)
        return
      }
      // console.log("Added sound meter for stream: " + streamId + " = " + soundMeter.instant.toFixed(2));
    })
  }
  /**
   * Called by user
   * To change audio/video constraints on the fly
   *
   */
  async applyConstraints(newConstraints, streamId) {
    let constraints = {}
    if (newConstraints.audio === undefined && newConstraints.video === undefined) {
      //if audio or video field is not defined, assume that it's a video constraint
      constraints.video = newConstraints
      this.mediaConstraints.video = Object.assign(
        {},
        this.mediaConstraints.video,
        constraints.video,
      )
    } else if (newConstraints.video !== undefined) {
      constraints.video = newConstraints.video
      this.mediaConstraints.video = Object.assign(
        {},
        this.mediaConstraints.video,
        constraints.video,
      )
    }

    if (newConstraints.audio !== undefined) {
      constraints.audio = newConstraints.audio

      this.mediaConstraints.audio = Object.assign(
        {},
        this.mediaConstraints.audio,
        constraints.audio,
      )
    }

    const mediaConstraints = this.getMediaConstraints()

    let promise = Promise.resolve()
    if (mediaConstraints.video !== undefined) {
      if (this.localStream && this.localStream.getVideoTracks().length > 0) {
        const videoTrack = this.localStream.getVideoTracks()[0]
        promise = videoTrack.applyConstraints(this.mediaConstraints.video)
      } else {
        promise = new Promise((resolve, reject) => {
          reject('There is no video track to apply constraints')
        })
      }
    }

    if (mediaConstraints.audio !== undefined && streamId) {
      // just give the audio constraints not to get video stream
      promise = this.setAudioInputSource(streamId, { audio: mediaConstraints.audio }, null)
    }

    return promise
  }
}
