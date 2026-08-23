using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text;

namespace SoulForge.Bridge
{
    /// <summary>
    /// Havok HKX 动画解码器与样条解压引擎（Clean-room 独立实现）。
    /// 基于 SoulsFormats (MIT) 与 Havok B-spline / De Boor 算法。
    /// 支持只狼（Sekiro: Shadows Die Twice）HKASplineCompressedAnimation 与 HKAAnimationBinding。
    /// </summary>
    public sealed class HkxNativeAnimation
    {
        [Flags]
        public enum FlagOffset : byte
        {
            StaticX = 1,
            StaticY = 2,
            StaticZ = 4,
            StaticW = 8,
            SplineX = 0x10,
            SplineY = 0x20,
            SplineZ = 0x40,
            SplineW = 0x80
        }

        public enum ScalarQuantizationType
        {
            Bits8 = 0,
            Bits16 = 1
        }

        public enum RotationQuantizationType
        {
            Polar32 = 0,
            ThreeComp40 = 1,
            ThreeComp48 = 2,
            ThreeComp24 = 3,
            Straight16 = 4,
            Uncompressed = 5
        }

        public sealed class SplineChannel<T>
        {
            public bool IsDynamic = true;
            public List<T> Values = new();
        }

        public sealed class SplineTrackQuaternion
        {
            public SplineChannel<Quaternion> Channel = new();
            public List<byte> Knots = new();
            public byte Degree;

            internal SplineTrackQuaternion(BinaryReaderEx br, RotationQuantizationType quantizationType)
            {
                short num = br.ReadInt16();
                Degree = br.ReadByte();
                int knotCount = num + Degree + 2;
                for (int i = 0; i < knotCount; i++)
                {
                    Knots.Add(br.ReadByte());
                }
                br.Pad(GetRotationAlign(quantizationType));
                Channel = new SplineChannel<Quaternion>();
                for (int j = 0; j <= num; j++)
                {
                    Channel.Values.Add(ReadQuantizedQuaternion(br, quantizationType));
                }
            }

            public Quaternion GetValue(float frame)
            {
                if (Channel.Values.Count == 0) return Quaternion.Identity;
                if (Channel.Values.Count == 1) return Channel.Values[0];
                return GetSinglePointQuat(FindKnotSpan(Degree, frame, Channel.Values.Count, Knots), Degree, frame, Knots, Channel.Values);
            }
        }

        public sealed class SplineTrackVector3
        {
            public SplineChannel<float>? ChannelX;
            public SplineChannel<float>? ChannelY;
            public SplineChannel<float>? ChannelZ;
            public List<byte> Knots = new();
            public byte Degree;

            internal SplineTrackVector3(BinaryReaderEx br, List<FlagOffset> channelTypes, ScalarQuantizationType quantizationType, bool isPosition)
            {
                short num = br.ReadInt16();
                Degree = br.ReadByte();
                int knotCount = num + Degree + 2;
                for (int i = 0; i < knotCount; i++)
                {
                    Knots.Add(br.ReadByte());
                }
                br.Pad(4);
                float minX = 0f, maxX = 0f;
                float minY = 0f, maxY = 0f;
                float minZ = 0f, maxZ = 0f;

                ChannelX = new SplineChannel<float>();
                ChannelY = new SplineChannel<float>();
                ChannelZ = new SplineChannel<float>();

                if (channelTypes.Contains(FlagOffset.SplineX))
                {
                    minX = br.ReadSingle();
                    maxX = br.ReadSingle();
                }
                else if (channelTypes.Contains(FlagOffset.StaticX))
                {
                    ChannelX.Values = new List<float> { br.ReadSingle() };
                    ChannelX.IsDynamic = false;
                }
                else
                {
                    ChannelX = null;
                }

                if (channelTypes.Contains(FlagOffset.SplineY))
                {
                    minY = br.ReadSingle();
                    maxY = br.ReadSingle();
                }
                else if (channelTypes.Contains(FlagOffset.StaticY))
                {
                    ChannelY.Values = new List<float> { br.ReadSingle() };
                    ChannelY.IsDynamic = false;
                }
                else
                {
                    ChannelY = null;
                }

                if (channelTypes.Contains(FlagOffset.SplineZ))
                {
                    minZ = br.ReadSingle();
                    maxZ = br.ReadSingle();
                }
                else if (channelTypes.Contains(FlagOffset.StaticZ))
                {
                    ChannelZ.Values = new List<float> { br.ReadSingle() };
                    ChannelZ.IsDynamic = false;
                }
                else
                {
                    ChannelZ = null;
                }

                for (int j = 0; j <= num; j++)
                {
                    if (channelTypes.Contains(FlagOffset.SplineX))
                        ChannelX?.Values.Add(ReadQuantizedFloat(br, minX, maxX, quantizationType));
                    if (channelTypes.Contains(FlagOffset.SplineY))
                        ChannelY?.Values.Add(ReadQuantizedFloat(br, minY, maxY, quantizationType));
                    if (channelTypes.Contains(FlagOffset.SplineZ))
                        ChannelZ?.Values.Add(ReadQuantizedFloat(br, minZ, maxZ, quantizationType));
                }
            }

            public float? GetValueX(float frame)
            {
                if (ChannelX == null || ChannelX.Values.Count == 0) return null;
                if (ChannelX.Values.Count == 1) return ChannelX.Values[0];
                return GetSinglePointFloat(FindKnotSpan(Degree, frame, ChannelX.Values.Count, Knots), Degree, frame, Knots, ChannelX.Values);
            }

            public float? GetValueY(float frame)
            {
                if (ChannelY == null || ChannelY.Values.Count == 0) return null;
                if (ChannelY.Values.Count == 1) return ChannelY.Values[0];
                return GetSinglePointFloat(FindKnotSpan(Degree, frame, ChannelY.Values.Count, Knots), Degree, frame, Knots, ChannelY.Values);
            }

            public float? GetValueZ(float frame)
            {
                if (ChannelZ == null || ChannelZ.Values.Count == 0) return null;
                if (ChannelZ.Values.Count == 1) return ChannelZ.Values[0];
                return GetSinglePointFloat(FindKnotSpan(Degree, frame, ChannelZ.Values.Count, Knots), Degree, frame, Knots, ChannelZ.Values);
            }
        }

        public sealed class TransformMask
        {
            public ScalarQuantizationType PositionQuantizationType;
            public RotationQuantizationType RotationQuantizationType;
            public ScalarQuantizationType ScaleQuantizationType;
            public List<FlagOffset> PositionTypes = new();
            public List<FlagOffset> RotationTypes = new();
            public List<FlagOffset> ScaleTypes = new();

            internal TransformMask(BinaryReaderEx br)
            {
                byte b0 = br.ReadByte();
                byte b1 = br.ReadByte();
                byte b2 = br.ReadByte();
                byte b3 = br.ReadByte();

                PositionQuantizationType = (ScalarQuantizationType)(b0 & 3);
                RotationQuantizationType = (RotationQuantizationType)((b0 >> 2) & 0xF);
                ScaleQuantizationType = (ScalarQuantizationType)((b0 >> 6) & 3);

                FlagOffset[] flagValues = (FlagOffset[])Enum.GetValues(typeof(FlagOffset));
                foreach (var f in flagValues)
                {
                    if (((FlagOffset)b1 & f) != 0) PositionTypes.Add(f);
                    if (((FlagOffset)b2 & f) != 0) RotationTypes.Add(f);
                    if (((FlagOffset)b3 & f) != 0) ScaleTypes.Add(f);
                }
            }
        }

        public sealed class TransformTrack
        {
            public TransformMask Mask = null!;
            public bool HasSplinePosition;
            public bool HasSplineRotation;
            public bool HasSplineScale;
            public bool HasStaticRotation;

            public Vector3 StaticPosition = Vector3.Zero;
            public Quaternion StaticRotation = Quaternion.Identity;
            public Vector3 StaticScale = Vector3.One;

            public SplineTrackVector3? SplinePosition;
            public SplineTrackQuaternion? SplineRotation;
            public SplineTrackVector3? SplineScale;
        }

        public readonly struct BoneTransform
        {
            public readonly float Px;
            public readonly float Py;
            public readonly float Pz;
            public readonly float Qx;
            public readonly float Qy;
            public readonly float Qz;
            public readonly float Qw;
            public readonly float Sx;
            public readonly float Sy;
            public readonly float Sz;

            public BoneTransform(float px, float py, float pz, float qx, float qy, float qz, float qw, float sx, float sy, float sz)
            {
                Px = px; Py = py; Pz = pz;
                Qx = qx; Qy = qy; Qz = qz; Qw = qw;
                Sx = sx; Sy = sy; Sz = sz;
            }

            public static BoneTransform Identity => new(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }

        public string Name { get; }
        public float Duration { get; }
        public float FrameDuration { get; }
        public int FrameCount { get; }
        public int TrackCount { get; }
        public int BlockCount { get; }
        public int FramesPerBlock { get; }
        public int[] TrackToBoneMap { get; }
        public int[] BoneToTrackMap { get; }
        public List<TransformTrack[]> Blocks { get; }

        public HkxNativeAnimation(
            string name,
            float duration,
            float frameDuration,
            int frameCount,
            int trackCount,
            int blockCount,
            int framesPerBlock,
            int[] trackToBoneMap,
            int[] boneToTrackMap,
            List<TransformTrack[]> blocks)
        {
            Name = name;
            Duration = duration;
            FrameDuration = frameDuration;
            FrameCount = frameCount;
            TrackCount = trackCount;
            BlockCount = blockCount;
            FramesPerBlock = framesPerBlock;
            TrackToBoneMap = trackToBoneMap;
            BoneToTrackMap = boneToTrackMap;
            Blocks = blocks;
        }

        public BoneTransform SampleTrack(int trackIndex, float frame, bool loop)
        {
            if (Blocks.Count == 0 || trackIndex < 0 || trackIndex >= TrackCount)
                return BoneTransform.Identity;

            if (FrameCount <= 0) return BoneTransform.Identity;

            while (frame < 0f) frame += FrameCount;

            float clampedFrame = loop
                ? (FrameCount > 1 ? (frame % (FrameCount - 1)) : 0f)
                : Math.Min(frame, FrameCount - 1);

            int block = FramesPerBlock > 1
                ? (int)(clampedFrame / (FramesPerBlock - 1))
                : 0;
            if (block >= Blocks.Count) block = Blocks.Count - 1;
            if (block < 0) block = 0;

            float blockFrame = FramesPerBlock > 1
                ? (clampedFrame % (FramesPerBlock - 1))
                : 0f;

            var track = Blocks[block][trackIndex];

            // 1. Position
            float px = 0f, py = 0f, pz = 0f;
            if (track.SplinePosition != null)
            {
                px = track.SplinePosition.GetValueX(blockFrame) ?? 0f;
                py = track.SplinePosition.GetValueY(blockFrame) ?? 0f;
                pz = track.SplinePosition.GetValueZ(blockFrame) ?? 0f;
            }
            else
            {
                if (track.Mask.PositionTypes.Contains(FlagOffset.StaticX)) px = track.StaticPosition.X;
                if (track.Mask.PositionTypes.Contains(FlagOffset.StaticY)) py = track.StaticPosition.Y;
                if (track.Mask.PositionTypes.Contains(FlagOffset.StaticZ)) pz = track.StaticPosition.Z;
            }

            // 2. Rotation
            Quaternion rot = Quaternion.Identity;
            if (track.SplineRotation != null)
            {
                rot = track.SplineRotation.GetValue(blockFrame);
            }
            else if (track.HasStaticRotation)
            {
                rot = track.StaticRotation;
            }

            // 3. Scale
            float sx = 1f, sy = 1f, sz = 1f;
            if (track.SplineScale != null)
            {
                sx = track.SplineScale.GetValueX(blockFrame) ?? 1f;
                sy = track.SplineScale.GetValueY(blockFrame) ?? 1f;
                sz = track.SplineScale.GetValueZ(blockFrame) ?? 1f;
            }
            else
            {
                if (track.Mask.ScaleTypes.Contains(FlagOffset.StaticX)) sx = track.StaticScale.X;
                if (track.Mask.ScaleTypes.Contains(FlagOffset.StaticY)) sy = track.StaticScale.Y;
                if (track.Mask.ScaleTypes.Contains(FlagOffset.StaticZ)) sz = track.StaticScale.Z;
            }

            return new BoneTransform(px, py, pz, rot.X, rot.Y, rot.Z, rot.W, sx, sy, sz);
        }

        public BoneTransform SampleBone(int boneIndex, float frame, bool loop, BoneTransform defaultPose)
        {
            if (boneIndex < 0 || boneIndex >= BoneToTrackMap.Length)
                return defaultPose;

            int trackIndex = BoneToTrackMap[boneIndex];
            if (trackIndex < 0) return defaultPose;

            return SampleTrack(trackIndex, frame, loop);
        }

        public BoneTransform[] SampleAllBones(float frame, bool loop, IReadOnlyList<BoneTransform>? refSkeletonBones = null)
        {
            int totalBones = refSkeletonBones != null ? refSkeletonBones.Count : BoneToTrackMap.Length;
            var result = new BoneTransform[totalBones];
            for (int i = 0; i < totalBones; i++)
            {
                var defaultPose = refSkeletonBones != null && i < refSkeletonBones.Count
                    ? refSkeletonBones[i]
                    : BoneTransform.Identity;
                result[i] = SampleBone(i, frame, loop, defaultPose);
            }
            return result;
        }

        #region Spline & Quantization Math

        private static int GetRotationAlign(RotationQuantizationType qt) => qt switch
        {
            RotationQuantizationType.Polar32 => 4,
            RotationQuantizationType.ThreeComp40 => 1,
            RotationQuantizationType.ThreeComp48 => 2,
            RotationQuantizationType.ThreeComp24 => 1,
            RotationQuantizationType.Straight16 => 2,
            RotationQuantizationType.Uncompressed => 4,
            _ => 4
        };

        private static float ReadQuantizedFloat(BinaryReaderEx bin, float min, float max, ScalarQuantizationType type)
        {
            return type switch
            {
                ScalarQuantizationType.Bits8 => min + (max - min) * ((float)bin.ReadByte() / 255f),
                ScalarQuantizationType.Bits16 => min + (max - min) * ((float)bin.ReadUInt16() / 65535f),
                _ => min
            };
        }

        private static Quaternion ReadQuatPOLAR32(BinaryReaderEx br)
        {
            uint num = br.ReadUInt32();
            float num2 = BitConverter.ToSingle(BitConverter.GetBytes((num >> 18) & 0x3FFu), 0) * 0.0009775171f;
            num2 = 1f - num2 * num2;
            float num3 = num & 0x3FFFFu;
            float num4 = (float)Math.Floor(Math.Sqrt(num3));
            float num5 = 0f;
            if (num4 > 0f)
            {
                num5 = (float)Math.PI / 4f * (num3 - num4 * num4) / num4;
                num4 = 0.0030739654f * num4;
            }
            float num6 = (float)Math.Sqrt(Math.Max(0.0, 1.0 - (double)num2 * num2));
            Quaternion result = default;
            result.X = (float)(Math.Sin(num4) * Math.Cos(num5) * (double)num6);
            result.Y = (float)(Math.Sin(num4) * Math.Sin(num5) * (double)num6);
            result.Z = (float)(Math.Cos(num4) * (double)num6);
            result.W = num2;
            if ((num & 0x10000000u) != 0) result.X *= -1f;
            if ((num & 0x20000000u) != 0) result.Y *= -1f;
            if ((num & 0x40000000u) != 0) result.Z *= -1f;
            if ((num & 0x80000000u) != 0) result.W *= -1f;
            return result;
        }

        private static Quaternion ReadQuatTHREECOMP48(BinaryReaderEx br)
        {
            short n1 = br.ReadInt16();
            short n2 = br.ReadInt16();
            short n3 = br.ReadInt16();
            int c = ((n2 >> 14) & 2) | ((n1 >> 15) & 1);
            bool flag = (n3 >> 15) != 0;
            n1 = (short)((n1 & 0x7FFF) - 16383);
            n2 = (short)((n2 & 0x7FFF) - 16383);
            n3 = (short)((n3 & 0x7FFF) - 16383);
            float[] array = { (float)n1 * 4.3161E-05f, (float)n2 * 4.3161E-05f, (float)n3 * 4.3161E-05f };
            float[] array2 = new float[4];
            for (int i = 0; i < 4; i++)
            {
                if (i < c) array2[i] = array[i];
                else if (i > c) array2[i] = array[i - 1];
            }
            float rem = 1f - array[0] * array[0] - array[1] * array[1] - array[2] * array[2];
            array2[c] = rem <= 0f ? 0f : (float)Math.Sqrt(rem);
            if (flag) array2[c] *= -1f;
            return new Quaternion(array2[0], array2[1], array2[2], array2[3]);
        }

        private static Quaternion ReadQuatTHREECOMP40(BinaryReaderEx br)
        {
            byte[] bytes = br.ReadBytes(5);
            Array.Resize(ref bytes, 8);
            ulong num = BitConverter.ToUInt64(bytes, 0);
            int n1 = (int)(num & 0xFFF) - 2047;
            int n2 = (int)((num >> 12) & 0xFFF) - 2047;
            int n3 = (int)((num >> 24) & 0xFFF) - 2047;
            int num5 = (int)((num >> 36) & 3);
            float[] array = { (float)n1 * 0.000345436f, (float)n2 * 0.000345436f, (float)n3 * 0.000345436f };
            float[] array2 = new float[4];
            for (int i = 0; i < 4; i++)
            {
                if (i < num5) array2[i] = array[i];
                else if (i > num5) array2[i] = array[i - 1];
            }
            float rem = 1f - array[0] * array[0] - array[1] * array[1] - array[2] * array[2];
            array2[num5] = rem <= 0f ? 0f : (float)Math.Sqrt(rem);
            if (((num >> 38) & 1) != 0) array2[num5] *= -1f;
            return new Quaternion(array2[0], array2[1], array2[2], array2[3]);
        }

        private static Quaternion ReadQuantizedQuaternion(BinaryReaderEx br, RotationQuantizationType type) => type switch
        {
            RotationQuantizationType.Polar32 => ReadQuatPOLAR32(br),
            RotationQuantizationType.ThreeComp40 => ReadQuatTHREECOMP40(br),
            RotationQuantizationType.ThreeComp48 => ReadQuatTHREECOMP48(br),
            RotationQuantizationType.Uncompressed => new Quaternion(br.ReadSingle(), br.ReadSingle(), br.ReadSingle(), br.ReadSingle()),
            _ => Quaternion.Identity
        };

        private static int FindKnotSpan(int degree, float value, int cPointsSize, List<byte> knots)
        {
            if (knots.Count <= cPointsSize) return Math.Max(0, cPointsSize - 1);
            if (value >= (float)(int)knots[cPointsSize])
            {
                return cPointsSize - 1;
            }
            int low = degree;
            int high = cPointsSize;
            int mid = (low + high) / 2;
            while (value < (float)(int)knots[mid] || value >= (float)(int)knots[mid + 1])
            {
                if (value < (float)(int)knots[mid]) high = mid;
                else low = mid;
                mid = (low + high) / 2;
                if (low >= high - 1) break;
            }
            return mid;
        }

        private static float GetSinglePointFloat(int knotSpanIndex, int degree, float frame, List<byte> knots, List<float> cPoints)
        {
            float[] array = { 1f, 0f, 0f, 0f, 0f };
            for (int i = 1; i <= degree && i < 5; i++)
            {
                for (int num = i - 1; num >= 0; num--)
                {
                    int k1 = knotSpanIndex - num;
                    int k2 = knotSpanIndex + i - num;
                    if (k1 < 0 || k2 >= knots.Count || knots[k2] == knots[k1]) continue;
                    float num2 = (frame - (float)(int)knots[k1]) / (float)(knots[k2] - knots[k1]);
                    float num3 = array[num] * num2;
                    array[num + 1] += array[num] - num3;
                    array[num] = num3;
                }
            }
            float num4 = 0f;
            for (int j = 0; j <= degree; j++)
            {
                int cpIdx = knotSpanIndex - j;
                if (cpIdx >= 0 && cpIdx < cPoints.Count && j < 5)
                {
                    num4 += cPoints[cpIdx] * array[j];
                }
            }
            return num4;
        }

        private static Quaternion GetSinglePointQuat(int knotSpanIndex, int degree, float frame, List<byte> knots, List<Quaternion> cPoints)
        {
            float[] array = { 1f, 0f, 0f, 0f, 0f };
            for (int i = 1; i <= degree && i < 5; i++)
            {
                for (int num = i - 1; num >= 0; num--)
                {
                    int k1 = knotSpanIndex - num;
                    int k2 = knotSpanIndex + i - num;
                    if (k1 < 0 || k2 >= knots.Count || knots[k2] == knots[k1]) continue;
                    float num2 = (frame - (float)(int)knots[k1]) / (float)(knots[k2] - knots[k1]);
                    float num3 = array[num] * num2;
                    array[num + 1] += array[num] - num3;
                    array[num] = num3;
                }
            }
            Quaternion result = new(0, 0, 0, 0);
            if (knotSpanIndex >= 0)
            {
                for (int j = 0; j <= degree; j++)
                {
                    int cpIdx = knotSpanIndex - j;
                    if (cpIdx >= 0 && cpIdx < cPoints.Count && j < 5)
                    {
                        var cp = cPoints[cpIdx];
                        result.X += cp.X * array[j];
                        result.Y += cp.Y * array[j];
                        result.Z += cp.Z * array[j];
                        result.W += cp.W * array[j];
                    }
                }
            }
            float len = result.Length();
            if (len > 0.00001f) result = Quaternion.Normalize(result);
            else result = Quaternion.Identity;
            return result;
        }

        #endregion

        #region HKX Binary Parser

        public sealed class BinaryReaderEx : IDisposable
        {
            private readonly MemoryStream _ms;
            private readonly BinaryReader _br;

            public BinaryReaderEx(byte[] data)
            {
                _ms = new MemoryStream(data);
                _br = new BinaryReader(_ms);
            }

            public long Position
            {
                get => _ms.Position;
                set => _ms.Position = value;
            }

            public long Length => _ms.Length;

            public byte ReadByte() => _br.ReadByte();
            public short ReadInt16() => _br.ReadInt16();
            public ushort ReadUInt16() => _br.ReadUInt16();
            public int ReadInt32() => _br.ReadInt32();
            public uint ReadUInt32() => _br.ReadUInt32();
            public ulong ReadUInt64() => _br.ReadUInt64();
            public float ReadSingle() => _br.ReadSingle();
            public byte[] ReadBytes(int count) => _br.ReadBytes(count);

            public void Pad(int align)
            {
                if (align <= 0) return;
                long rem = _ms.Position % align;
                if (rem != 0) _ms.Position += (align - rem);
            }

            public void Dispose()
            {
                _br.Dispose();
                _ms.Dispose();
            }
        }

        public static List<TransformTrack[]> ReadSplineCompressedAnimByteBlock(byte[] animationData, int numTransformTracks, int numBlocks)
        {
            var list = new List<TransformTrack[]>();
            using var br = new BinaryReaderEx(animationData);
            for (int i = 0; i < numBlocks; i++)
            {
                var tracks = new TransformTrack[numTransformTracks];
                for (int j = 0; j < numTransformTracks; j++) tracks[j] = new TransformTrack();
                for (int k = 0; k < numTransformTracks; k++) tracks[k].Mask = new TransformMask(br);
                br.Pad(4);

                for (int l = 0; l < numTransformTracks; l++)
                {
                    var mask = tracks[l].Mask;
                    var track = tracks[l];
                    track.HasSplinePosition = mask.PositionTypes.Contains(FlagOffset.SplineX) || mask.PositionTypes.Contains(FlagOffset.SplineY) || mask.PositionTypes.Contains(FlagOffset.SplineZ);
                    track.HasSplineRotation = mask.RotationTypes.Contains(FlagOffset.SplineX) || mask.RotationTypes.Contains(FlagOffset.SplineY) || mask.RotationTypes.Contains(FlagOffset.SplineZ) || mask.RotationTypes.Contains(FlagOffset.SplineW);
                    track.HasStaticRotation = mask.RotationTypes.Contains(FlagOffset.StaticX) || mask.RotationTypes.Contains(FlagOffset.StaticY) || mask.RotationTypes.Contains(FlagOffset.StaticZ) || mask.RotationTypes.Contains(FlagOffset.StaticW);
                    track.HasSplineScale = mask.ScaleTypes.Contains(FlagOffset.SplineX) || mask.ScaleTypes.Contains(FlagOffset.SplineY) || mask.ScaleTypes.Contains(FlagOffset.SplineZ);

                    if (track.HasSplinePosition)
                    {
                        track.SplinePosition = new SplineTrackVector3(br, mask.PositionTypes, mask.PositionQuantizationType, isPosition: true);
                    }
                    else
                    {
                        if (mask.PositionTypes.Contains(FlagOffset.StaticX)) track.StaticPosition.X = br.ReadSingle();
                        if (mask.PositionTypes.Contains(FlagOffset.StaticY)) track.StaticPosition.Y = br.ReadSingle();
                        if (mask.PositionTypes.Contains(FlagOffset.StaticZ)) track.StaticPosition.Z = br.ReadSingle();
                    }
                    br.Pad(4);

                    if (track.HasSplineRotation)
                    {
                        track.SplineRotation = new SplineTrackQuaternion(br, mask.RotationQuantizationType);
                    }
                    else if (track.HasStaticRotation)
                    {
                        br.Pad(GetRotationAlign(mask.RotationQuantizationType));
                        track.StaticRotation = ReadQuantizedQuaternion(br, mask.RotationQuantizationType);
                    }
                    br.Pad(4);

                    if (track.HasSplineScale)
                    {
                        track.SplineScale = new SplineTrackVector3(br, mask.ScaleTypes, mask.ScaleQuantizationType, isPosition: false);
                    }
                    else
                    {
                        if (mask.ScaleTypes.Contains(FlagOffset.StaticX)) track.StaticScale.X = br.ReadSingle();
                        if (mask.ScaleTypes.Contains(FlagOffset.StaticY)) track.StaticScale.Y = br.ReadSingle();
                        if (mask.ScaleTypes.Contains(FlagOffset.StaticZ)) track.StaticScale.Z = br.ReadSingle();
                    }
                    br.Pad(4);
                }
                br.Pad(16);
                list.Add(tracks);
            }
            return list;
        }

        private sealed class LocalFixup
        {
            public uint Src;
            public uint Dst;
        }

        private sealed class VirtualFixup
        {
            public uint Src;
            public uint SectionIndex;
            public uint NameOffset;
        }

        private sealed class RawSection
        {
            public string Name = "";
            public uint AbsoluteDataStart;
            public uint LocalFixupsOffset;
            public uint GlobalFixupsOffset;
            public uint VirtualFixupsOffset;
            public uint ExportsOffset;
            public uint ImportsOffset;
            public uint EndOffset;
            public byte[] SectionData = Array.Empty<byte>();
            public List<LocalFixup> LocalFixups = new();
            public List<VirtualFixup> VirtualFixups = new();
        }

        public static (HkxNativeAnimation? Anim, string? Error) ReadFromHkxBytesWithDiag(byte[] hkxBytes, string name, int boneCount = 0, byte[]? compendiumBytes = null)
        {
            if (hkxBytes.Length < 0x20) return (null, $"Length {hkxBytes.Length} < 0x20");
            uint magic0 = BinaryPrimitives.ReadUInt32LittleEndian(hkxBytes.AsSpan(0, 4));
            if (magic0 != 0x57E0E057)
            {
                return ReadFromTagfileBytes(hkxBytes, name, boneCount, compendiumBytes);
            }

            using var br = new BinaryReaderEx(hkxBytes);
            br.ReadUInt32(); // magic0
            br.ReadUInt32(); // magic1
            br.ReadInt32();  // userTag
            int version = br.ReadInt32();
            byte pointerSize = br.ReadByte();
            byte endian = br.ReadByte();
            br.ReadByte(); // paddingOption
            br.ReadByte(); // baseClass
            int sectionCount = br.ReadInt32();
            int contentsSectionIndex = br.ReadInt32();
            int contentsSectionOffset = br.ReadInt32();
            int contentsClassNameSectionIndex = br.ReadInt32();
            int contentsClassNameSectionOffset = br.ReadInt32();
            byte[] contentsVersionString = br.ReadBytes(16);
            int flags = br.ReadInt32();

            long sectionHeaderStart = 0x40;
            if (version >= 0x0B)
            {
                br.ReadInt16();
                short sectionOffset = br.ReadInt16();
                br.ReadUInt32();
                br.ReadUInt32();
                br.ReadUInt32();
                br.ReadUInt32();
                sectionHeaderStart = sectionOffset + 0x40;
            }
            else
            {
                br.ReadUInt32(); // 0xFFFFFFFF
            }

            br.Position = sectionHeaderStart;
            var sections = new List<RawSection>();
            for (int s = 0; s < sectionCount; s++)
            {
                var sec = new RawSection();
                byte[] nameBytes = br.ReadBytes(19);
                sec.Name = Encoding.ASCII.GetString(nameBytes).TrimEnd('\0');
                br.ReadByte(); // 0xFF
                sec.AbsoluteDataStart = br.ReadUInt32();
                sec.LocalFixupsOffset = br.ReadUInt32();
                sec.GlobalFixupsOffset = br.ReadUInt32();
                sec.VirtualFixupsOffset = br.ReadUInt32();
                sec.ExportsOffset = br.ReadUInt32();
                sec.ImportsOffset = br.ReadUInt32();
                sec.EndOffset = br.ReadUInt32();

                // 64-bit HKX padding (16 bytes)
                br.ReadUInt32();
                br.ReadUInt32();
                br.ReadUInt32();
                br.ReadUInt32();

                long nextSectionPos = br.Position;

                // Read SectionData
                if (sec.LocalFixupsOffset > 0 && sec.AbsoluteDataStart + sec.LocalFixupsOffset <= hkxBytes.Length)
                {
                    br.Position = sec.AbsoluteDataStart;
                    sec.SectionData = br.ReadBytes((int)sec.LocalFixupsOffset);
                }

                // Read LocalFixups
                if (sec.GlobalFixupsOffset > sec.LocalFixupsOffset && sec.AbsoluteDataStart + sec.GlobalFixupsOffset <= hkxBytes.Length)
                {
                    br.Position = sec.AbsoluteDataStart + sec.LocalFixupsOffset;
                    int localCount = (int)(sec.GlobalFixupsOffset - sec.LocalFixupsOffset) / 8;
                    for (int i = 0; i < localCount; i++)
                    {
                        uint src = br.ReadUInt32();
                        if (src != 0xFFFFFFFF)
                        {
                            uint dst = br.ReadUInt32();
                            sec.LocalFixups.Add(new LocalFixup { Src = src, Dst = dst });
                        }
                    }
                }

                // Read VirtualFixups
                if (sec.ExportsOffset > sec.VirtualFixupsOffset && sec.AbsoluteDataStart + sec.ExportsOffset <= hkxBytes.Length)
                {
                    br.Position = sec.AbsoluteDataStart + sec.VirtualFixupsOffset;
                    int virtCount = (int)(sec.ExportsOffset - sec.VirtualFixupsOffset) / 12;
                    for (int i = 0; i < virtCount; i++)
                    {
                        uint src = br.ReadUInt32();
                        if (src != 0xFFFFFFFF)
                        {
                            uint secIdx = br.ReadUInt32();
                            uint nameOff = br.ReadUInt32();
                            sec.VirtualFixups.Add(new VirtualFixup { Src = src, SectionIndex = secIdx, NameOffset = nameOff });
                        }
                    }
                }

                br.Position = nextSectionPos;
                sections.Add(sec);
            }

            if (sections.Count < 3) return (null, $"sections.Count {sections.Count} < 3");

            var classSection = sections[0];
            var dataSection = sections[2];

            // Parse class names from classSection.SectionData
            var classNames = new Dictionary<uint, string>();
            if (classSection.SectionData.Length > 0)
            {
                using var cbr = new BinaryReaderEx(classSection.SectionData);
                while (cbr.Position < cbr.Length - 4)
                {
                    if (cbr.ReadUInt16() == 0xFFFF) break;
                    cbr.Position -= 2;
                    uint stringStart = (uint)cbr.Position + 5;
                    cbr.ReadUInt32(); // signature
                    cbr.ReadByte();   // separator 0x09
                    var sb = new StringBuilder();
                    while (cbr.Position < cbr.Length)
                    {
                        byte b = cbr.ReadByte();
                        if (b == 0) break;
                        sb.Append((char)b);
                    }
                    classNames[stringStart] = sb.ToString();
                }
            }

            // Find hkaSplineCompressedAnimation and hkaAnimationBinding
            float duration = 0f;
            int transformTrackCount = 0;
            int frameCount = 0;
            int blockCount = 1;
            int framesPerBlock = 255;
            float frameDuration = 1f / 30f;
            byte[]? animSplineData = null;
            int[]? trackToBoneIndices = null;

            foreach (var vf in dataSection.VirtualFixups)
            {
                if (!classNames.TryGetValue(vf.NameOffset, out var className)) continue;

                if (className == "hkaSplineCompressedAnimation")
                {
                    using var dbr = new BinaryReaderEx(dataSection.SectionData);
                    dbr.Position = vf.Src;

                    // Pointers
                    if (pointerSize == 8)
                    {
                        dbr.ReadUInt64(); // vtable
                        dbr.ReadUInt64(); // pointer
                    }
                    else
                    {
                        dbr.ReadUInt32();
                        dbr.ReadUInt32();
                    }

                    int animType = dbr.ReadInt32();
                    duration = dbr.ReadSingle();
                    transformTrackCount = dbr.ReadInt32();
                    int floatTrackCount = dbr.ReadInt32();

                    // Annotations (3 x 8 = 24 bytes in 64-bit HKX)
                    if (pointerSize == 8)
                    {
                        dbr.ReadUInt64();
                        dbr.ReadUInt64();
                        dbr.ReadUInt64();
                    }
                    else
                    {
                        dbr.ReadUInt32();
                        dbr.ReadUInt32();
                    }

                    frameCount = dbr.ReadInt32();
                    blockCount = dbr.ReadInt32();
                    framesPerBlock = dbr.ReadInt32();
                    uint maskAndQuant = dbr.ReadUInt32();
                    float blockDur = dbr.ReadSingle();
                    float invBlockDur = dbr.ReadSingle();
                    frameDuration = dbr.ReadSingle();
                    dbr.ReadUInt32(); // padding

                    // BlockOffsets array (16B), FloatBlockOffsets array (16B), TransformBlockOffsets array (16B), FloatOffsets array (16B)
                    dbr.Position += 16 * 4;

                    // Data array (Pointer 8B, Size 4B, Cap 4B)
                    long dataArrayPtrOffset = dbr.Position;
                    dbr.ReadUInt64(); // pointer placeholder
                    uint dataSize = dbr.ReadUInt32();

                    // Find local fixup for Data array pointer
                    var fixup = dataSection.LocalFixups.FirstOrDefault(f => f.Src == dataArrayPtrOffset);
                    if (fixup != null && fixup.Dst < dataSection.SectionData.Length)
                    {
                        int copyLen = Math.Min((int)dataSize, (int)(dataSection.SectionData.Length - fixup.Dst));
                        animSplineData = dataSection.SectionData.AsSpan((int)fixup.Dst, copyLen).ToArray();
                    }
                }
                else if (className == "hkaAnimationBinding")
                {
                    using var dbr = new BinaryReaderEx(dataSection.SectionData);
                    dbr.Position = vf.Src;

                    // Pointers
                    if (pointerSize == 8)
                    {
                        dbr.ReadUInt64();
                        dbr.ReadUInt64();
                        dbr.ReadUInt64();
                        dbr.ReadUInt64();
                    }
                    else
                    {
                        dbr.ReadUInt32();
                        dbr.ReadUInt32();
                        dbr.ReadUInt32();
                        dbr.ReadUInt32();
                    }

                    // TransformTrackToBoneIndices array (Pointer 8B, Size 4B, Cap 4B)
                    long trackArrayPtrOffset = dbr.Position;
                    dbr.ReadUInt64();
                    uint trackArraySize = dbr.ReadUInt32();

                    var fixup = dataSection.LocalFixups.FirstOrDefault(f => f.Src == trackArrayPtrOffset);
                    if (fixup != null && fixup.Dst < dataSection.SectionData.Length && trackArraySize > 0 && trackArraySize < 2000)
                    {
                        trackToBoneIndices = new int[trackArraySize];
                        for (int t = 0; t < trackArraySize; t++)
                        {
                            trackToBoneIndices[t] = BinaryPrimitives.ReadInt16LittleEndian(dataSection.SectionData.AsSpan((int)fixup.Dst + t * 2, 2));
                        }
                    }
                }
            }

            if (frameCount <= 0) return (null, $"frameCount <= 0 ({frameCount})");
            if (transformTrackCount <= 0) return (null, $"transformTrackCount <= 0 ({transformTrackCount})");
            if (animSplineData == null) return (null, "animSplineData == null");

            var blocks = ReadSplineCompressedAnimByteBlock(animSplineData, transformTrackCount, blockCount);

            int effectiveBoneCount = Math.Max(boneCount, transformTrackCount);
            if (trackToBoneIndices != null)
            {
                foreach (var b in trackToBoneIndices)
                {
                    if (b >= effectiveBoneCount) effectiveBoneCount = b + 1;
                }
            }

            int[] finalTrackToBone = trackToBoneIndices ?? Enumerable.Range(0, transformTrackCount).ToArray();
            int[] finalBoneToTrack = new int[effectiveBoneCount];
            for (int i = 0; i < effectiveBoneCount; i++) finalBoneToTrack[i] = -1;

            for (int t = 0; t < finalTrackToBone.Length; t++)
            {
                int b = finalTrackToBone[t];
                if (b >= 0 && b < finalBoneToTrack.Length)
                {
                    finalBoneToTrack[b] = t;
                }
            }

            return (new HkxNativeAnimation(
                name,
                duration,
                frameDuration,
                frameCount,
                transformTrackCount,
                blockCount,
                framesPerBlock,
                finalTrackToBone,
                finalBoneToTrack,
                blocks), null);
        }

        public static (HkxNativeAnimation? Anim, string? Error) ReadFromTagfileBytes(byte[] tagFileBytes, string name, int boneCount = 0, byte[]? compendiumBytes = null)
        {
            try
            {
                Havoc.Objects.IHkObject root = Havoc.IO.Tagfile.Binary.HkBinaryTagfileReader.Read(tagFileBytes, compendiumBytes);
                if (root == null) return (null, "Tagfile root is null");

                float duration = 0f;
                int transformTrackCount = 0;
                int frameCount = 0;
                int blockCount = 1;
                int framesPerBlock = 255;
                float frameDuration = 1f / 30f;
                byte[]? animSplineData = null;
                int[]? trackToBoneIndices = null;

                void TraverseHkObject(Havoc.Objects.IHkObject? obj)
                {
                    if (obj == null) return;
                    if (obj is Havoc.Objects.HkClass hkClass)
                    {
                        if (hkClass.Type.Name == "hkaSplineCompressedAnimation")
                        {
                            foreach (var kv in hkClass.Value)
                            {
                                if (kv.Key.Name == "duration" && kv.Value is Havoc.Objects.HkSingle dur) duration = dur.Value;
                                else if (kv.Key.Name == "numberOfTransformTracks" && kv.Value is Havoc.Objects.HkInt32 tracks) transformTrackCount = tracks.Value;
                                else if (kv.Key.Name == "numFrames" && kv.Value is Havoc.Objects.HkInt32 frames) frameCount = frames.Value;
                                else if (kv.Key.Name == "numBlocks" && kv.Value is Havoc.Objects.HkInt32 blocks) blockCount = blocks.Value;
                                else if (kv.Key.Name == "maxFramesPerBlock" && kv.Value is Havoc.Objects.HkInt32 fpb) framesPerBlock = fpb.Value;
                                else if (kv.Key.Name == "frameDuration" && kv.Value is Havoc.Objects.HkSingle fd) frameDuration = fd.Value;
                                else if (kv.Key.Name == "data" && kv.Value is Havoc.Objects.HkArray arr && arr.Value != null)
                                {
                                    var bytes = new byte[arr.Value.Count];
                                    for (int i = 0; i < arr.Value.Count; i++)
                                    {
                                        if (arr.Value[i] is Havoc.Objects.HkByte b) bytes[i] = b.Value;
                                    }
                                    animSplineData = bytes;
                                }
                            }
                        }
                        else if (hkClass.Type.Name == "hkaAnimationBinding")
                        {
                            foreach (var kv in hkClass.Value)
                            {
                                if (kv.Key.Name == "transformTrackToBoneIndices" && kv.Value is Havoc.Objects.HkArray arr && arr.Value != null)
                                {
                                    trackToBoneIndices = new int[arr.Value.Count];
                                    for (int i = 0; i < arr.Value.Count; i++)
                                    {
                                        if (arr.Value[i] is Havoc.Objects.HkInt16 val) trackToBoneIndices[i] = val.Value;
                                    }
                                }
                            }
                        }

                        foreach (var kv in hkClass.Value)
                        {
                            TraverseHkObject(kv.Value);
                        }
                    }
                    else if (obj is Havoc.Objects.HkArray arr && arr.Value != null)
                    {
                        foreach (var elem in arr.Value)
                        {
                            TraverseHkObject(elem);
                        }
                    }
                    else if (obj is Havoc.Objects.HkPtr ptr && ptr.Value != null)
                    {
                        TraverseHkObject(ptr.Value);
                    }
                }

                TraverseHkObject(root);

                if (frameCount <= 0) return (null, $"Tagfile frameCount <= 0 ({frameCount})");
                if (transformTrackCount <= 0) return (null, $"Tagfile transformTrackCount <= 0 ({transformTrackCount})");
                if (animSplineData == null) return (null, "Tagfile animSplineData == null");

                var blocks = ReadSplineCompressedAnimByteBlock(animSplineData, transformTrackCount, blockCount);

                int effectiveBoneCount = Math.Max(boneCount, transformTrackCount);
                if (trackToBoneIndices != null)
                {
                    foreach (var b in trackToBoneIndices)
                    {
                        if (b >= effectiveBoneCount) effectiveBoneCount = b + 1;
                    }
                }

                int[] finalTrackToBone = trackToBoneIndices ?? Enumerable.Range(0, transformTrackCount).ToArray();
                int[] finalBoneToTrack = new int[effectiveBoneCount];
                for (int i = 0; i < effectiveBoneCount; i++) finalBoneToTrack[i] = -1;

                for (int t = 0; t < finalTrackToBone.Length; t++)
                {
                    int b = finalTrackToBone[t];
                    if (b >= 0 && b < finalBoneToTrack.Length)
                    {
                        finalBoneToTrack[b] = t;
                    }
                }

                return (new HkxNativeAnimation(
                    name,
                    duration,
                    frameDuration,
                    frameCount,
                    transformTrackCount,
                    blockCount,
                    framesPerBlock,
                    finalTrackToBone,
                    finalBoneToTrack,
                    blocks), null);
            }
            catch (Exception ex)
            {
                return (null, $"Tagfile read exception: {ex.Message}");
            }
        }

        public static HkxNativeAnimation? ReadFromHkxBytes(byte[] hkxBytes, string name, int boneCount = 0)
        {
            return ReadFromHkxBytesWithDiag(hkxBytes, name, boneCount).Anim;
        }

        #endregion
    }
}
